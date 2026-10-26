import { selectorSpec, type SelectorSpec } from '../../core/selector.mjs'
import {
  ensure,
  ensureRanges,
  isNonEmptyString,
  withDefaults,
} from '../../core/validate.mjs'
import { observationSteps, type ObservationStep } from '../observe/steps.mjs'

export interface IpcActionConfig {
  cdp: string
  inspector: string
  /** The IPC channel the action writes through. Every call on it is answered by the hook. */
  channel: string
  /** Steps that bring the screen to the action, run after each reload. */
  setup: ObservationStep[]
  /** The control that sends the request. */
  action: SelectorSpec
  /** Simulated request time for the injected results. */
  latencyMs: number
  observationMs: number
  sampleMs: number
  regionSelector?: string
  restoreWindow: boolean
}

/** Requests the hook answers in one run; later ones reach the app's own handler. */
export const MAX_REQUESTS = 10

const DEFAULTS = {
  cdp: 'http://127.0.0.1:9222',
  inspector: 'http://127.0.0.1:9229',
  channel: undefined,
  setup: undefined,
  action: undefined,
  latencyMs: 400,
  observationMs: 6000,
  sampleMs: 100,
  regionSelector: undefined,
  restoreWindow: false,
}

const RANGES = [
  ['latencyMs', 0, 5000],
  ['observationMs', 1000, 30000],
  ['sampleMs', 50, 1000],
] as const

export function actionConfig(input: unknown): IpcActionConfig {
  const c: Record<string, unknown> = withDefaults(
    input,
    DEFAULTS,
    'Action config must be an object',
    (key) => `Unsupported action option: ${key}`,
  )
  ensure(
    isNonEmptyString(c.channel),
    'channel is required: the IPC channel the action writes through',
  )
  const setup = c.setup === undefined ? [] : observationSteps(c.setup)
  // Setup results are not reported, so an expectation there could fail unseen.
  ensure(
    !setup.some((step) => step.kind === 'expect'),
    'setup steps cannot use expect; use waitFor',
  )
  c.setup = setup
  c.action = selectorSpec(c.action, 'action')
  ensureRanges(c, RANGES)
  ensure(
    c.regionSelector === undefined || isNonEmptyString(c.regionSelector),
    'regionSelector must be a CSS selector',
  )
  ensure(typeof c.restoreWindow === 'boolean', 'restoreWindow must be boolean')
  return c as unknown as IpcActionConfig
}
