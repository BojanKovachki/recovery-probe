import type { Page } from 'playwright'
import { pageIdentity } from '../../core/urls.mjs'
import type { FaultKind } from '../../core/faults.mjs'
import { httpRefreshAdapter } from '../../transports/session.mjs'
import { runDiscovery, type DiscoveryResult } from './run.mjs'
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

// Configurations also come from JSON files, so every field is checked at runtime.
export function httpDiscoveryConfig(input: object): HttpDiscoveryConfig {
  const c: Record<string, unknown> = {
    endpoint: undefined,
    requiredEndpoints: [],
    cdp: 'http://127.0.0.1:9222',
    page: undefined,
    pageUrl: undefined,
    times: 2,
    faults: ['http-error', 'connection-failure', 'invalid-json'],
    baselineTimeoutMs: 15000,
    recoveryTimeoutMs: 8000,
    settleMs: 800,
    repeats: 3,
    regionSelector: undefined,
    restoreWindow: false,
  }
  for (const key of Object.keys(c))
    if (Object.hasOwn(input, key))
      c[key] = (input as Record<string, unknown>)[key]
  const endpoint = (value: unknown) => {
    const u = new URL(value as string)
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error(
        'Endpoints must be HTTP(S) origin/path without credentials, query or fragment',
      )
    return u.href
  }
  c.endpoint = endpoint(c.endpoint)
  if (!Array.isArray(c.requiredEndpoints))
    throw new Error('requiredEndpoints must be an array')
  const required = c.requiredEndpoints.map(endpoint)
  c.requiredEndpoints = required
  if (new Set([c.endpoint, ...required]).size !== required.length + 1)
    throw new Error('Use distinct endpoints')
  for (const key of ['baselineTimeoutMs', 'recoveryTimeoutMs']) {
    const value = c[key]
    if (
      !Number.isInteger(value) ||
      (value as number) < 500 ||
      (value as number) > 30000
    )
      throw new Error(`${key} must be 500–30000`)
  }
  const times = c.times as number
  if (!Number.isInteger(times) || times < 1 || times > 10)
    throw new Error('times must be 1–10')
  const settleMs = c.settleMs as number
  if (!Number.isInteger(settleMs) || settleMs < 200 || settleMs > 5000)
    throw new Error('settleMs must be 200–5000')
  const repeats = c.repeats as number
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3)
    throw new Error('repeats must be 1–3')
  const faults = c.faults
  if (
    !Array.isArray(faults) ||
    !faults.length ||
    faults.some(
      (f) => !['http-error', 'connection-failure', 'invalid-json'].includes(f),
    ) ||
    new Set(faults).size !== faults.length
  )
    throw new Error('Invalid faults')
  if (
    c.regionSelector !== undefined &&
    (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())
  )
    throw new Error('Invalid regionSelector')
  if (typeof c.restoreWindow !== 'boolean')
    throw new Error('restoreWindow must be boolean')
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
  const report: HttpDiscoveryReport = {
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
  const session = httpRefreshAdapter(page, config)
  await runDiscovery(
    {
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
        'Rerun the saved scenario with web --attach --discover after the local change. Compare this experiment and its healthy controls; a disappeared warning alone does not prove a fix.',
    },
    { ...config, observationMs: config.recoveryTimeoutMs },
    report,
    options,
  )
  report.coverage = session.coverage()
  return report
}
