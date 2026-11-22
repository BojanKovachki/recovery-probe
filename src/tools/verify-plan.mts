import {
  ensure,
  isIntegerIn,
  isNonEmptyString,
  isRecord,
} from '../core/validate.mjs'
import { validateCheckCommand } from './watch/checks.mjs'

const NAME = /^[\w.-]{1,40}$/

export interface VerifyCheck {
  name: string
  /** Recovery Probe arguments of the check, such as ["observe", "--config", "observe.json"]. */
  command: string[]
}

export interface VerifyPlan {
  /** The Git reference the change starts from; its changed lines are scanned for suspects. */
  base: string
  /** Runs of each check on each side. */
  runs: number
  checks: VerifyCheck[]
}

export function verifyPlan(input: unknown): VerifyPlan {
  ensure(isRecord(input), 'The plan must be { base?, runs?, checks }')
  const { base = 'main', runs = 3, checks, ...rest } = input
  const [unknown] = Object.keys(rest)
  if (unknown) throw new Error(`Unsupported plan option: ${unknown}`)
  ensure(isNonEmptyString(base), 'base must be a Git reference, such as main')
  ensure(isIntegerIn(runs, 1, 10), 'runs must be a whole number from 1 to 10')
  ensure(
    Array.isArray(checks) && checks.length > 0 && checks.length <= 20,
    'checks must list 1–20 { name, command } entries',
  )
  const plan: VerifyPlan = { base, runs, checks: [] }
  for (const [i, check] of checks.entries())
    plan.checks.push(planCheck(check, `checks[${i}]`, plan.checks))
  return plan
}

function planCheck(
  check: unknown,
  where: string,
  earlier: VerifyCheck[],
): VerifyCheck {
  const { name, command } = (check ?? {}) as Record<string, unknown>
  ensure(
    typeof name === 'string' && NAME.test(name),
    `${where}.name must match ${NAME}`,
  )
  ensure(
    !earlier.some((other) => other.name === name),
    `Check names must be unique: ${name}`,
  )
  ensure(
    Array.isArray(command) && command.every((arg) => typeof arg === 'string'),
    `${where}.command must be a list of arguments`,
  )
  validateCheckCommand(command)
  return { name, command: [...command] }
}
