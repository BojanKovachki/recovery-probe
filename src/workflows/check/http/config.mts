import {
  FAULT_KINDS,
  isFaultKind,
  type FaultKind,
} from '../../../core/faults.mjs'
import { pageIdentity } from '../../../core/urls.mjs'
import {
  ensure,
  ensureRanges,
  isIntegerIn,
  isNonEmptyString,
  isUnique,
} from '../../../core/validate.mjs'

export interface DesktopConfig {
  cdp?: string
  page?: number
  pageUrl: string
  endpoint: string
  readySelector: string
  readyText?: string
  busySelector?: string
  recovery?: 'retry' | 'automatic'
  retrySelector?: string
  timeoutMs?: number
  baselineTimeoutMs?: number
  recoveryTimeoutMs?: number
  times?: number
  faults?: FaultKind[]
}

/** A configuration after validation: defaults applied, the endpoint and page normalized. */
export type ValidDesktopConfig = DesktopConfig &
  Required<
    Pick<
      DesktopConfig,
      | 'recovery'
      | 'timeoutMs'
      | 'baselineTimeoutMs'
      | 'recoveryTimeoutMs'
      | 'times'
      | 'faults'
    >
  >

const PHASE_TIMEOUTS = [
  ['baselineTimeoutMs', 200, 60000],
  ['recoveryTimeoutMs', 200, 60000],
] as const

function plainEndpoint(value: string) {
  const endpoint = new URL(value)
  ensure(
    ['http:', 'https:'].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash,
    'endpoint must be an HTTP(S) origin and path, without credentials, query, or fragment',
  )
  return endpoint.href
}

const isFaultList = (value: unknown) =>
  Array.isArray(value) &&
  value.length > 0 &&
  isUnique(value) &&
  value.every(isFaultKind)

// Configurations also come from JSON files, so every field is checked at runtime.
// Other keys pass through to scenario.json, which the reproduction reads.
export function validateDesktopConfig(
  input: DesktopConfig,
): ValidDesktopConfig {
  const config: Record<string, unknown> = {
    times: 1,
    timeoutMs: 5000,
    recovery: 'retry',
    faults: [...FAULT_KINDS],
    ...input,
  }
  for (const key of ['pageUrl', 'endpoint', 'readySelector'])
    ensure(isNonEmptyString(config[key]), `${key} is required`)
  config.baselineTimeoutMs ??= config.timeoutMs
  config.recoveryTimeoutMs ??= config.timeoutMs
  ensureRanges(config, PHASE_TIMEOUTS, (key) => `Invalid ${key}`)
  ensureRanges(config, [['times', 1, 10]])
  config.endpoint = plainEndpoint(config.endpoint as string)
  config.pageUrl = pageIdentity(config.pageUrl as string)
  ensure(
    ['retry', 'automatic'].includes(config.recovery as string),
    'recovery must be retry or automatic',
  )
  ensure(
    config.recovery !== 'retry' || isNonEmptyString(config.retrySelector),
    'retrySelector is required for retry recovery',
  )
  for (const key of ['busySelector', 'readyText'])
    ensure(
      config[key] === undefined || isNonEmptyString(config[key]),
      `${key} must be a non-empty string`,
    )
  ensureRanges(config, [['timeoutMs', 200, 60000]])
  ensure(
    isFaultList(config.faults),
    'faults must contain unique supported fault kinds',
  )
  ensure(
    config.page === undefined || isIntegerIn(config.page, 0, Infinity),
    'page must be a non-negative integer',
  )
  return config as unknown as ValidDesktopConfig
}
