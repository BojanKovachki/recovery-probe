import type { Locator, Page } from 'playwright'
import { selectorSpec, type SelectorSpec } from './kit.mjs'
import {
  validateNetworkRules,
  type NetworkFaultRule,
} from '../../transports/net.mjs'

// Opt-in scripted operator for `observe --steps` and `action`. Steps act on the
// app (same-document navigation, clicks, typing, key presses, waits and interval marks)
// or, for observe, on its network through `recovery-probe net`; observation itself
// never acts. Typed values are never written to reports.
const NAME = /^[\w.-]{1,40}$/
const KEY = /^[A-Za-z0-9+]{1,40}$/
const KINDS = [
  'mark',
  'navigate',
  'click',
  'fill',
  'press',
  'waitFor',
  'wait',
  'network',
] as const
// The extra property a kind needs besides its selector.
const ARGUMENTS: Partial<Record<(typeof KINDS)[number], string>> = {
  fill: 'value',
  press: 'key',
}

export type ObservationStep = { name?: string } & (
  | { kind: 'mark' }
  | { kind: 'navigate'; target: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'click' | 'waitFor'; target: SelectorSpec; timeoutMs: number }
  | { kind: 'fill'; target: SelectorSpec; value: string; timeoutMs: number }
  | { kind: 'press'; target: SelectorSpec; key: string; timeoutMs: number }
  // `null` restores the network.
  | { kind: 'network'; rules: NetworkFaultRule[] | null }
)

/** Applies network steps; `step` is the index of the step that asked. */
export interface NetworkStepControl {
  arm(rules: NetworkFaultRule[], step: number): Promise<void>
  restore(step: number): Promise<void>
}

export interface StepResult {
  index: number
  kind: ObservationStep['kind']
  name?: string
  startedMs: number
  interval?: number | null
  status?: 'done' | 'failed'
  error?: string
  endedMs?: number
}

export function observationSteps(
  input: unknown,
  { network = false }: { network?: boolean } = {},
): ObservationStep[] {
  const steps = Array.isArray(input)
    ? input
    : (input as { steps?: unknown } | null | undefined)?.steps
  if (!Array.isArray(steps) || !steps.length || steps.length > 50)
    throw Error('steps must list 1–50 steps')
  return steps.map((value: unknown, i): ObservationStep => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error(`steps[${i}] must be an object`)
    const step = value as Record<string, unknown>
    const kinds = KINDS.filter((k) => Object.hasOwn(step, k))
    if (kinds.length !== 1)
      throw Error(`steps[${i}] needs exactly one of ${KINDS.join(', ')}`)
    const [kind] = kinds
    for (const key of Object.keys(step))
      if (![kind, 'name', 'timeoutMs', ARGUMENTS[kind]].includes(key))
        throw Error(`Unsupported steps[${i}] property: ${key}`)
    if (
      step.name !== undefined &&
      (typeof step.name !== 'string' || !NAME.test(step.name))
    )
      throw Error(`steps[${i}].name must match ${NAME}`)
    const timeoutMs = step.timeoutMs ?? (kind === 'waitFor' ? 15000 : 10000)
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 60000
    )
      throw Error(`steps[${i}].timeoutMs must be 100–60000`)
    const named = typeof step.name === 'string' ? { name: step.name } : {}
    if (kind === 'mark') {
      if (step.mark !== true) throw Error(`steps[${i}].mark must be true`)
      return { kind, ...named }
    }
    if (kind === 'network') {
      if (!network)
        throw Error(
          `steps[${i}].network needs a network control: observe --network URL`,
        )
      if (step.network === 'restore') return { kind, rules: null, ...named }
      try {
        const rules = validateNetworkRules(
          Array.isArray(step.network) ? step.network : [step.network],
        )
        return { kind, rules, ...named }
      } catch (error) {
        throw Error(`steps[${i}].network: ${(error as Error).message}`, {
          cause: error,
        })
      }
    }
    if (kind === 'navigate') {
      // Same-document fragment navigation only: a document load would reset the state under observation.
      if (
        typeof step.navigate !== 'string' ||
        !/^#\S{0,500}$/.test(step.navigate)
      )
        throw Error(`steps[${i}].navigate must be a same-document #fragment`)
      return { kind, target: step.navigate, ...named }
    }
    if (kind === 'wait') {
      if (
        typeof step.wait !== 'number' ||
        !Number.isInteger(step.wait) ||
        step.wait < 0 ||
        step.wait > 60000
      )
        throw Error(`steps[${i}].wait must be 0–60000 ms`)
      return { kind, ms: step.wait, ...named }
    }
    const target = selectorSpec(step[kind], `steps[${i}].${kind}`)
    if (kind === 'fill') {
      if (typeof step.value !== 'string' || step.value.length > 1000)
        throw Error(`steps[${i}].value must be text up to 1000 characters`)
      return { kind, target, value: step.value, timeoutMs, ...named }
    }
    if (kind === 'press') {
      if (typeof step.key !== 'string' || !KEY.test(step.key))
        throw Error(
          `steps[${i}].key must be a key name such as Enter or Control+A`,
        )
      return { kind, target, key: step.key, timeoutMs, ...named }
    }
    return { kind, target, timeoutMs, ...named }
  })
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function locate(page: Page, spec: SelectorSpec): Locator {
  if (typeof spec === 'string') return page.locator(spec)
  let locator = spec.css ? page.locator(spec.css) : null
  if (spec.role) {
    const byRole = page.getByRole(
      spec.role as Parameters<Page['getByRole']>[0],
      spec.name === undefined ? {} : { name: spec.name, exact: true },
    )
    locator = locator ? locator.and(byRole) : byRole
  }
  // Validated selectors always have css or role.
  if (!locator) throw Error('A selector needs css or role')
  if (spec.text !== undefined)
    locator = locator.filter({
      hasText: new RegExp(`^\\s*${escapeRegExp(spec.text)}\\s*$`),
    })
  return locator
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Error('STEPS_STOPPED'))
      return
    }
    const stop = () => reject(Error('STEPS_STOPPED'))
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

/** Runs steps in order. Clicks, typing and key presses require exactly one visible match and use real input events. */
export async function runSteps(
  page: Page,
  steps: ObservationStep[],
  {
    mark,
    signal,
    elapsed,
    log = () => {},
    network,
  }: {
    mark: () => Promise<number | null>
    signal: AbortSignal
    elapsed: () => number
    log?: (result: StepResult) => void
    network?: NetworkStepControl
  },
): Promise<StepResult[]> {
  const results: StepResult[] = []
  for (const [index, step] of steps.entries()) {
    const result: StepResult = {
      index,
      kind: step.kind,
      ...(step.name ? { name: step.name } : {}),
      startedMs: elapsed(),
    }
    results.push(result)
    try {
      if (step.kind === 'mark')
        result.interval = await abortable(mark(), signal)
      else if (step.kind === 'navigate')
        await abortable(
          page.evaluate((fragment) => {
            location.hash = fragment
          }, step.target),
          signal,
        )
      else if (step.kind === 'wait')
        await abortable(
          new Promise((resolve) => setTimeout(resolve, step.ms)),
          signal,
        )
      else if (step.kind === 'network') {
        if (!network) throw Error('NETWORK_CONTROL_MISSING')
        await abortable(
          step.rules ? network.arm(step.rules, index) : network.restore(index),
          signal,
        )
      } else if (step.kind === 'waitFor')
        await abortable(
          locate(page, step.target)
            .filter({ visible: true })
            .first()
            .waitFor({ state: 'visible', timeout: step.timeoutMs }),
          signal,
        )
      else {
        const target = locate(page, step.target).filter({ visible: true })
        const count = await abortable(target.count(), signal)
        if (count !== 1)
          throw Error(
            `STEP_TARGET_NOT_UNIQUE: expected exactly one visible match, found ${count}`,
          )
        await abortable(
          step.kind === 'fill'
            ? target.fill(step.value, { timeout: step.timeoutMs })
            : step.kind === 'press'
              ? target.press(step.key, { timeout: step.timeoutMs })
              : target.click({ timeout: step.timeoutMs }),
          signal,
        )
      }
      result.status = 'done'
    } catch (error) {
      result.status = 'failed'
      result.error = String((error as Error).message)
        .split('\n')[0]
        .slice(0, 300)
      throw Object.assign(
        Error(`Step ${index} (${step.kind}) failed: ${result.error}`),
        { results },
      )
    } finally {
      result.endedMs = elapsed()
      log(result)
    }
  }
  return results
}
