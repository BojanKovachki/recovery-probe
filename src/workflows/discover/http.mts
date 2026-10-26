import type { Page } from 'playwright'
import { pageIdentity } from '../../core/urls.mjs'
import { FAULT_KINDS, isFaultKind, type FaultKind } from '../../core/faults.mjs'
import {
  ensure,
  ensureRanges,
  isNonEmptyString,
  isUnique,
  overDefaults,
} from '../../core/validate.mjs'
import { httpRefreshAdapter } from '../../transports/session.mjs'
import { runDiscovery } from './run.mjs'
import type { DiscoveryResult, DiscoverySetup } from './types.mjs'
import type { DiscoveryScreenshot } from './screenshots.mjs'

export interface HttpDiscoveryConfig {
  endpoint: string
  requiredEndpoints: string[]
  cdp: string
  page?: number
  pageUrl?: string
  times: number
  faults: FaultKind[]
  baselineTimeoutMs: number
  recoveryTimeoutMs: number
  settleMs: number
  repeats: number
  regionSelector?: string
  restoreWindow: boolean
}

type HttpSession = ReturnType<typeof httpRefreshAdapter>
type HttpSnapshot = ReturnType<HttpSession['snapshot']>

export interface HttpDiscoveryReport extends DiscoveryResult<
  FaultKind,
  HttpSnapshot
> {
  schemaVersion: 2
  mode: 'HTTP discovery'
  coverage: ReturnType<HttpSession['coverage']>
  readiness: DiscoveryResult<FaultKind, HttpSnapshot>['readiness'] & {
    strategy: 'bounded-end-state-calibration'
    calibrationRuns: number
    calibrationWindowMs: number
    relevantEndpoints: string[]
    settleMs: number
    note: string
  }
  limitation: string
}

// A function, so each config gets its own arrays.
const defaults = () => ({
  endpoint: undefined,
  requiredEndpoints: [],
  cdp: 'http://127.0.0.1:9222',
  page: undefined,
  pageUrl: undefined,
  times: 2,
  faults: [...FAULT_KINDS],
  baselineTimeoutMs: 15000,
  recoveryTimeoutMs: 8000,
  settleMs: 800,
  repeats: 3,
  regionSelector: undefined,
  restoreWindow: false,
})

const RANGES = [
  ['baselineTimeoutMs', 500, 30000],
  ['recoveryTimeoutMs', 500, 30000],
  ['times', 1, 10],
  ['settleMs', 200, 5000],
  ['repeats', 1, 3],
] as const

function endpoint(value: unknown) {
  const u = new URL(value as string)
  ensure(
    ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    'Endpoints must be HTTP(S) origin/path without credentials, query or fragment',
  )
  return u.href
}

// Configurations also come from JSON files, so every field is checked at runtime.
export function httpDiscoveryConfig(input: object): HttpDiscoveryConfig {
  const c: Record<string, unknown> = overDefaults(input, defaults())
  c.endpoint = endpoint(c.endpoint)
  ensure(
    Array.isArray(c.requiredEndpoints),
    'requiredEndpoints must be an array',
  )
  const required = c.requiredEndpoints.map(endpoint)
  c.requiredEndpoints = required
  ensure(isUnique([c.endpoint, ...required]), 'Use distinct endpoints')
  ensureRanges(c, RANGES)
  const faults = c.faults
  ensure(
    Array.isArray(faults) &&
      faults.length > 0 &&
      faults.every(isFaultKind) &&
      isUnique(faults),
    'Invalid faults',
  )
  ensure(
    c.regionSelector === undefined || isNonEmptyString(c.regionSelector),
    'Invalid regionSelector',
  )
  ensure(typeof c.restoreWindow === 'boolean', 'restoreWindow must be boolean')
  return c as unknown as HttpDiscoveryConfig
}

export async function discoverHttp(
  page: Page,
  input: object,
  options: { screenshot?: DiscoveryScreenshot } = {},
): Promise<HttpDiscoveryReport> {
  const config = httpDiscoveryConfig(input)
  if (
    config.pageUrl &&
    pageIdentity(page.url()) !== pageIdentity(config.pageUrl)
  )
    throw new Error('Page identity mismatch')
  const report = initialReport(config)
  const session = httpRefreshAdapter(page, config)
  await runDiscovery(
    discoverySetup(page, session, config),
    { ...config, observationMs: config.recoveryTimeoutMs },
    report,
    options,
  )
  report.coverage = session.coverage()
  return report
}

function initialReport(config: HttpDiscoveryConfig): HttpDiscoveryReport {
  return {
    schemaVersion: 2,
    mode: 'HTTP discovery',
    baselines: [],
    results: [],
    findings: [],
    coverage: [],
    finalReset: 'not-verified',
    ok: false,
    readiness: {
      strategy: 'bounded-end-state-calibration',
      calibrationRuns: 3,
      calibrationWindowMs: config.baselineTimeoutMs,
      calibrationComplete: false,
      relevantEndpoints: [config.endpoint, ...config.requiredEndpoints],
      settleMs: config.settleMs,
      note: 'Only selected dependencies gate readiness. Matching stable end states do not prove completeness beyond the calibration window.',
    },
    limitation:
      'Synthetic GET fetch/XHR faults on the selected origin/path; query variants share the budget. Observed structural changes are not semantic proof of a defect. Native, IPC and service-worker-only traffic are not covered. No payloads, raw UI text or credentials are saved.',
  }
}

function discoverySetup(
  page: Page,
  session: HttpSession,
  config: HttpDiscoveryConfig,
): DiscoverySetup<FaultKind, HttpSnapshot> {
  return {
    page,
    session,
    read: config.endpoint,
    dependencies: config.requiredEndpoints,
    readKind: 'endpoint',
    readFailed: 'REAL_REQUEST_FAILED',
    experiments: config.faults.map((fault) => ({
      fault,
      times: config.times,
    })),
    laterCallFault: config.faults[0],
    verification:
      'Rerun the saved scenario with recovery-probe discover after the local change. Compare this experiment and its healthy controls; a disappeared warning alone does not prove a fix.',
  }
}
