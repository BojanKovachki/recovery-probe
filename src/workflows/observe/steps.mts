import { selectorSpec, type SelectorSpec } from '../../core/selector.mjs'
import { ensure, isIntegerIn, isRecord } from '../../core/validate.mjs'
import {
  validateNetworkRules,
  type NetworkFaultRule,
} from '../../transports/net.mjs'

// Opt-in scripted operator for `observe --steps` and `action`. Steps act on the
// app (same-document navigation, clicks, typing, key presses, waits and interval marks)
// or, for observe, on its network through `recovery-probe net` and on its files under
// `--files`; observation itself never acts. Typed values are never written to reports.
const NAME = /^[\w.-]{1,40}$/
const KEY = /^[A-Za-z0-9+]{1,40}$/
const KINDS = [
  'mark',
  'navigate',
  'click',
  'fill',
  'press',
  'waitFor',
  'expect',
  'wait',
  'network',
  'file',
] as const
type StepKind = (typeof KINDS)[number]

/** How a file step damages a file: deletes it, cuts it to half its size, or changes bytes in its middle. */
export const FILE_FAULTS = ['remove', 'truncate', 'corrupt'] as const
export type FileFault = (typeof FILE_FAULTS)[number]

// The extra property a kind needs besides its selector.
const ARGUMENTS: Partial<Record<StepKind, string>> = {
  fill: 'value',
  press: 'key',
}

export type ObservationStep = { name?: string } & (
  | { kind: 'mark' }
  | { kind: 'navigate'; target: string }
  | { kind: 'wait'; ms: number }
  | {
      kind: 'click' | 'waitFor' | 'expect'
      target: SelectorSpec
      timeoutMs: number
    }
  | { kind: 'fill'; target: SelectorSpec; value: string; timeoutMs: number }
  | { kind: 'press'; target: SelectorSpec; key: string; timeoutMs: number }
  // `null` restores the network.
  | { kind: 'network'; rules: NetworkFaultRule[] | null }
  // `path` is relative to the `--files` directory, with `/` separators.
  | { kind: 'file'; path: string; fault: FileFault }
)

/** Applies network steps; `step` is the index of the step that asked. */
export interface NetworkStepControl {
  arm(rules: NetworkFaultRule[], step: number): Promise<void>
  restore(step: number): Promise<void>
}

/** Applies file steps; `step` is the index of the step that asked. */
export interface FileStepControl {
  damage(path: string, fault: FileFault, step: number): Promise<void>
}

export interface StepResult {
  index: number
  kind: ObservationStep['kind']
  name?: string
  startedMs: number
  interval?: number | null
  /** `unmet`: an `expect` step saw no visible match in time; the script went on. */
  status?: 'done' | 'failed' | 'unmet'
  error?: string
  endedMs?: number
}

interface StepOptions {
  network?: boolean
  files?: boolean
}

/** A step being validated: its input, where it is in the list, and what every kind shares. */
interface StepInput {
  step: Record<string, unknown>
  /** `steps[i]`, for error messages. */
  at: string
  named: { name?: string }
  timeoutMs: number
  options: StepOptions
}

export function observationSteps(
  input: unknown,
  options: StepOptions = {},
): ObservationStep[] {
  const steps = Array.isArray(input)
    ? input
    : (input as { steps?: unknown } | null | undefined)?.steps
  ensure(
    Array.isArray(steps) && steps.length > 0 && steps.length <= 50,
    'steps must list 1–50 steps',
  )
  return steps.map((value: unknown, i) =>
    observationStep(value, `steps[${i}]`, options),
  )
}

function observationStep(
  value: unknown,
  at: string,
  options: StepOptions,
): ObservationStep {
  ensure(isRecord(value), `${at} must be an object`)
  const kinds = KINDS.filter((k) => Object.hasOwn(value, k))
  ensure(kinds.length === 1, `${at} needs exactly one of ${KINDS.join(', ')}`)
  const [kind] = kinds
  const allowed = [kind, 'name', 'timeoutMs', ARGUMENTS[kind]]
  for (const key of Object.keys(value))
    ensure(allowed.includes(key), `Unsupported ${at} property: ${key}`)
  const name = value.name
  ensure(
    name === undefined || (typeof name === 'string' && NAME.test(name)),
    `${at}.name must match ${NAME}`,
  )
  const timeoutMs =
    value.timeoutMs ?? (kind === 'waitFor' || kind === 'expect' ? 15000 : 10000)
  ensure(
    isIntegerIn(timeoutMs, 100, 60000),
    `${at}.timeoutMs must be 100–60000`,
  )
  const named = typeof name === 'string' ? { name } : {}
  return PARSERS[kind]({ step: value, at, named, timeoutMs, options })
}

/** A selector step: the element it acts on or waits for. */
const targetStep =
  (kind: 'click' | 'waitFor' | 'expect') =>
  ({ step, at, named, timeoutMs }: StepInput): ObservationStep => ({
    kind,
    target: selectorSpec(step[kind], `${at}.${kind}`),
    timeoutMs,
    ...named,
  })

const PARSERS: Record<StepKind, (input: StepInput) => ObservationStep> = {
  mark({ step, at, named }) {
    ensure(step.mark === true, `${at}.mark must be true`)
    return { kind: 'mark', ...named }
  },
  navigate({ step, at, named }) {
    // Same-document fragment navigation only: a document load would reset the state under observation.
    const target = step.navigate
    ensure(
      typeof target === 'string' && /^#\S{0,500}$/.test(target),
      `${at}.navigate must be a same-document #fragment`,
    )
    return { kind: 'navigate', target, ...named }
  },
  wait({ step, at, named }) {
    ensure(isIntegerIn(step.wait, 0, 60000), `${at}.wait must be 0–60000 ms`)
    return { kind: 'wait', ms: step.wait, ...named }
  },
  click: targetStep('click'),
  waitFor: targetStep('waitFor'),
  expect: targetStep('expect'),
  fill({ step, at, named, timeoutMs }) {
    const target = selectorSpec(step.fill, `${at}.fill`)
    const value = step.value
    ensure(
      typeof value === 'string' && value.length <= 1000,
      `${at}.value must be text up to 1000 characters`,
    )
    return { kind: 'fill', target, value, timeoutMs, ...named }
  },
  press({ step, at, named, timeoutMs }) {
    const target = selectorSpec(step.press, `${at}.press`)
    const key = step.key
    ensure(
      typeof key === 'string' && KEY.test(key),
      `${at}.key must be a key name such as Enter or Control+A`,
    )
    return { kind: 'press', target, key, timeoutMs, ...named }
  },
  network: networkStep,
  file: fileStep,
}

function networkStep({ step, at, named, options }: StepInput): ObservationStep {
  ensure(
    options.network,
    `${at}.network needs a network control: observe --network URL`,
  )
  if (step.network === 'restore')
    return { kind: 'network', rules: null, ...named }
  try {
    const rules = validateNetworkRules(
      Array.isArray(step.network) ? step.network : [step.network],
    )
    return { kind: 'network', rules, ...named }
  } catch (error) {
    throw Error(`${at}.network: ${(error as Error).message}`, { cause: error })
  }
}

function fileStep({ step, at, named, options }: StepInput): ObservationStep {
  ensure(options.files, `${at}.file needs a directory: observe --files DIR`)
  const file = step.file
  ensure(isRecord(file), `${at}.file must be an object`)
  for (const key of Object.keys(file))
    ensure(
      key === 'path' || key === 'fault',
      `Unsupported ${at}.file property: ${key}`,
    )
  const path = pathInDirectory(file.path)
  ensure(
    path,
    `${at}.file.path must be a relative path inside the --files directory`,
  )
  const fault = file.fault as FileFault
  ensure(
    FILE_FAULTS.includes(fault),
    `${at}.file.fault must be ${FILE_FAULTS.join(', ')}`,
  )
  return { kind: 'file', path, fault, ...named }
}

/**
 * A path relative to the `--files` directory, with `/` separators, or `undefined`
 * when it is absolute or climbs out of the directory.
 */
function pathInDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 500) return
  const parts = value.split(/[\\/]/)
  // An empty part is a leading separator (an absolute path), a doubled or a trailing one.
  if (/^[A-Za-z]:/.test(value) || parts.some((p) => p === '..' || p === ''))
    return
  return parts.filter((part) => part !== '.').join('/') || undefined
}
