import { performance } from 'node:perf_hooks'
import { ensure, isNonEmptyString } from '../../core/validate.mjs'
import type { NetworkFaultRule, NetworkRuleSummary } from './types.mjs'

export interface ArmedRule extends NetworkFaultRule {
  matching: number
  applied: number
}

const FAULTS = new Set<unknown>(['refuse', 'reset', 'stall', 'delay'])

const isWholeNumber = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0

export function hostMatches(pattern: string, host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  pattern = pattern.toLowerCase().replace(/\.$/, '')
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1))
  return name === pattern
}

export function validateNetworkRules(rules: unknown): NetworkFaultRule[] {
  ensure(
    Array.isArray(rules) && rules.length > 0,
    'rules must be a non-empty array',
    TypeError,
  )
  return rules.map((rule, index) => validateRule(rule, `rules[${index}]`))
}

function validateRule(rule: NetworkFaultRule, where: string) {
  const check = (condition: boolean, problem: string) =>
    ensure(condition, `${where}.${problem}`, TypeError)
  check(isNonEmptyString(rule?.host), 'host must be a host name')
  check(FAULTS.has(rule.fault), 'fault must be refuse, reset, stall or delay')
  check(
    rule.fault !== 'delay' || isWholeNumber(rule.delayMs),
    'delayMs must be a whole number of milliseconds',
  )
  check(
    rule.count === undefined || (isWholeNumber(rule.count) && rule.count > 0),
    'count must be a positive integer',
  )
  for (const key of ['fromMs', 'untilMs'] as const)
    check(
      rule[key] === undefined || isWholeNumber(rule[key]),
      `${key} must be a whole number of milliseconds`,
    )
  check(
    rule.untilMs === undefined || rule.untilMs > (rule.fromMs ?? 0),
    'untilMs must be after fromMs',
  )
  return { ...rule, host: rule.host.trim().toLowerCase() }
}

/** The armed rules: which one faults a connection, and how often each matched and applied. */
export class ArmedRules {
  #rules: ArmedRule[] = []
  #active = false
  #armedAt = 0

  /** Replaces the rules; their windows start now. */
  arm(rules: NetworkFaultRule[]): { rules: ArmedRule[]; armedAt: number } {
    this.#rules = rules.map((rule) => ({ ...rule, matching: 0, applied: 0 }))
    this.#armedAt = performance.now()
    this.#active = true
    return { rules: this.#rules, armedAt: this.#armedAt }
  }

  disarm() {
    this.#active = false
  }

  at(index: number): ArmedRule {
    return this.#rules[index]
  }

  /** The index of the rule that faults a connection to `host`, or -1. */
  select(host: string): number {
    if (!this.#active) return -1
    const elapsed = performance.now() - this.#armedAt
    let selected = -1
    this.#rules.forEach((rule, index) => {
      if (!appliesAt(rule, host, elapsed)) return
      rule.matching += 1
      if (
        selected === -1 &&
        (rule.count === undefined || rule.applied < rule.count)
      )
        selected = index
    })
    if (selected !== -1) this.#rules[selected].applied += 1
    return selected
  }

  summaries(): NetworkRuleSummary[] {
    return this.#rules.map(({ host, fault, matching, applied }) => ({
      host,
      fault,
      matching,
      applied,
    }))
  }
}

const appliesAt = (rule: ArmedRule, host: string, elapsed: number) =>
  hostMatches(rule.host, host) &&
  elapsed >= (rule.fromMs ?? 0) &&
  (rule.untilMs === undefined || elapsed < rule.untilMs)
