import { matchesHealthyControl, retainPartialFindings } from './experiment.mjs'
import { performance } from 'node:perf_hooks'
import type { Page } from 'playwright'
import { pageIdentity } from '../../core/urls.mjs'
import {
  callsGap,
  findingId,
  laterCalls,
  type DiscoveryExperiment,
  type DiscoveryFinding,
} from './experiment.mjs'
import { screenshotRun, type DiscoveryScreenshot } from './screenshots.mjs'
import type { FaultKind } from '../../core/faults.mjs'
import {
  readRegion,
  summarizeRegion,
  compareRegions,
  classifyObservation,
  type RegionSummary,
} from '../../core/screen.mjs'
import { observeHttp } from '../../transports/http/observer.mjs'
import {
  prepareVisibility,
  windowVisibility,
  type WindowVisibility,
} from '../../targets/visibility.mjs'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

type HttpObserver = Awaited<ReturnType<typeof observeHttp>>
type HttpSnapshot = ReturnType<HttpObserver['snapshot']>
type CoverageEntry = ReturnType<HttpObserver['coverage']>[number]

interface DiscoveryEvent {
  elapsedMs: number
  ui: RegionSummary
  channels: HttpSnapshot['channels']
  injected: number
}

type Experiment = DiscoveryExperiment<FaultKind>

interface DiscoveryPhase {
  fault: FaultKind | 'healthy'
  times: number
  /** The read of the load that failed, when it was not the first. */
  call?: number
  screenshot?: string
  evidenceCaptureFailed?: true
  ready: boolean
  elapsedMs: number
  ui: RegionSummary
  snapshot: HttpSnapshot
  timeline: DiscoveryEvent[]
  newErrors: number
  recoveryMs: number | null
  repeatedReads: {
    code: 'REPEATED_READS'
    endpoint: string
    count: number
    redundant: 'not-established'
  }[]
}

interface DiscoveryRun extends DiscoveryPhase {
  control: { ui: RegionSummary; snapshot: HttpSnapshot }
  observation: ReturnType<typeof compareRegions> & {
    injected: number
    channels: HttpSnapshot['channels']
    recoveryMs: number | null
    repeatedReads: DiscoveryPhase['repeatedReads']
  }
  interpretation: ReturnType<typeof classifyObservation>
}

type PreparedVisibility = Awaited<ReturnType<typeof prepareVisibility>>

export interface HttpDiscoveryReport {
  schemaVersion: 2
  mode: 'HTTP discovery'
  baselines: DiscoveryPhase[]
  results: DiscoveryRun[]
  findings: DiscoveryFinding[]
  coverage: CoverageEntry[]
  finalReset: 'healthy' | 'not-verified'
  ok: boolean
  readiness: {
    strategy: 'bounded-end-state-calibration'
    calibrationRuns: number
    calibrationWindowMs: number
    calibrationComplete: boolean
    relevantEndpoints: string[]
    settleMs: number
    /** How often each healthy calibration load read the selected endpoint. */
    callsPerLoad?: number[]
    callsGap?: string
    note: string
  }
  limitation: string
  window?: {
    initial: WindowVisibility
    restoration?: Awaited<ReturnType<PreparedVisibility['revert']>>
  }
  environment?: WindowVisibility & { online: boolean }
  stoppedObservation?: {
    reason: string
    fault: FaultKind | 'healthy'
    times: number
    snapshot: HttpSnapshot | undefined
    ui: RegionSummary | undefined
    timeline: DiscoveryEvent[]
  }
  failedControl?: DiscoveryPhase & {
    reasons: {
      notReady: boolean
      newErrors: number
      fingerprintChanged: boolean
    }
    diff: ReturnType<typeof compareRegions>
  }
  cleanup?: DiscoveryPhase
  error?: string
  cleanupError?: string
  windowRestoreError?: string
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
  { screenshot }: { screenshot?: DiscoveryScreenshot } = {},
): Promise<HttpDiscoveryReport> {
  const config = httpDiscoveryConfig(input)
  const initialUrl = page.url()
  if (
    config.pageUrl &&
    pageIdentity(initialUrl) !== pageIdentity(config.pageUrl)
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
  const coverage = new Map<string, CoverageEntry>()
  let visibility: PreparedVisibility | undefined,
    errors = 0,
    trustedFingerprint: string | undefined
  const settleMs = config.settleMs
  const onError = () => errors++
  page.on('pageerror', onError)
  const phase = async (
    experiment: Experiment | undefined,
    expectedFingerprint?: string,
    calibrate = false,
  ): Promise<DiscoveryPhase> => {
    const { fault, times = 1, call } = experiment ?? {}
    const started = performance.now(),
      initialErrors = errors,
      timeline: DiscoveryEvent[] = []
    let observer: HttpObserver | undefined,
      snapshot: HttpSnapshot | undefined,
      ui: RegionSummary | undefined,
      previous: string | undefined,
      previousEvent: string | undefined,
      stableSince = started,
      firstInjection: number | undefined
    try {
      observer = await observeHttp(page, {
        ...config,
        fault,
        times,
        skip: call ? call - 1 : 0,
      })
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: config.baselineTimeoutMs,
      })
      while (true) {
        const current = observer.snapshot()
        snapshot = current
        const summary = summarizeRegion(
          await page.evaluate(readRegion, config.regionSelector),
        )
        ui = summary
        if (!summary.visible || !summary.online) {
          report.environment = {
            ...(await windowVisibility(page)),
            online: summary.online,
          }
          throw new Error(
            'ENVIRONMENT_BLOCKED: ' + report.environment.diagnosis,
          )
        }
        if (page.url() !== initialUrl) throw new Error('TARGET_NAVIGATED')
        if (current.injectionError) throw new Error('INJECTION_ERROR')
        if (current.injectedAt && firstInjection === undefined)
          firstInjection = performance.now()
        const signature = JSON.stringify(summary)
        if (signature !== previous) {
          stableSince = performance.now()
          previous = signature
        }
        const event = {
          elapsedMs: Math.round(performance.now() - started),
          ui: summary,
          channels: current.channels,
          injected: current.injected,
        }
        const eventSignature = JSON.stringify({ ...event, elapsedMs: 0 })
        if (timeline.length < 100 && eventSignature !== previousEvent) {
          timeline.push(event)
          previousEvent = eventSignature
        }
        const target = current.channels[config.endpoint]
        const dependencies = config.requiredEndpoints.map(
          (e) => current.channels[e],
        )
        if (dependencies.some((r) => r.errors))
          throw new Error('DEPENDENCY_FAILED')
        if (target.errors) throw new Error('REAL_REQUEST_FAILED')
        const settled =
          target.pending === 0 &&
          dependencies.every((r) => r.successes > 0 && r.pending === 0)
        const ready =
          matchesHealthyControl(summary, expectedFingerprint) &&
          settled &&
          !summary.loading &&
          performance.now() - stableSince >= settleMs &&
          target.successes > 0 &&
          (!fault ||
            (current.injected === times &&
              current.successfulAfterFault > 0 &&
              summary.fingerprint === trustedFingerprint))
        const elapsed = performance.now() - (firstInjection ?? started)
        if (
          (!calibrate && ready) ||
          elapsed >=
            (firstInjection === undefined
              ? config.baselineTimeoutMs
              : config.recoveryTimeoutMs)
        )
          return {
            fault: fault ?? 'healthy',
            times: fault ? times : 0,
            ...(call ? { call } : {}),
            ready,
            elapsedMs: Math.round(performance.now() - started),
            ui: summary,
            snapshot: current,
            timeline,
            newErrors: errors - initialErrors,
            // As before, a missing injection time counts as 0.
            recoveryMs:
              fault && ready ? Date.now() - (current.injectedAt ?? 0) : null,
            repeatedReads: Object.entries(current.channels)
              .filter(([, r]) => r.realCalls > 1)
              .map(([endpoint, r]) => ({
                code: 'REPEATED_READS' as const,
                endpoint,
                count: r.realCalls,
                redundant: 'not-established' as const,
              })),
          }
        await sleep(100)
      }
    } catch (error) {
      report.stoppedObservation ??= {
        reason: (error as Error).message,
        fault: fault ?? 'healthy',
        times,
        snapshot,
        ui,
        timeline,
      }
      throw error
    } finally {
      if (observer) {
        for (const entry of observer.coverage())
          coverage.set(entry.method + entry.endpoint, entry)
        await observer.stop()
      }
    }
  }
  try {
    visibility = await prepareVisibility(page, config)
    report.window = { initial: visibility.initial }
    for (let i = 0; i < 3; i++) {
      const baseline = await phase(undefined, undefined, true)
      if (i === 0)
        Object.assign(
          baseline,
          await screenshotRun(screenshot, page, 'baseline'),
        )
      report.baselines.push(baseline)
      if (!baseline.ready || baseline.newErrors)
        throw new Error('BASELINE_UNSTABLE')
    }
    if (
      !report.baselines.every(
        (b) => b.ui.fingerprint === report.baselines[0].ui.fingerprint,
      )
    )
      throw new Error('BASELINE_UNSTABLE')
    trustedFingerprint = report.baselines[0].ui.fingerprint
    report.readiness.calibrationComplete = true
    const callsPerLoad = report.baselines.map(
      (b) => b.snapshot.channels[config.endpoint].realCalls,
    )
    report.readiness.callsPerLoad = callsPerLoad
    report.readiness.callsGap = callsGap(callsPerLoad)
    const experiments: Experiment[] = [
      ...config.faults.map((fault) => ({ fault, times: config.times })),
      ...laterCalls(callsPerLoad).map((call) => ({
        fault: config.faults[0],
        times: 1,
        call,
      })),
    ]
    for (const experiment of experiments) {
      const id = findingId(experiment)
      const runs: DiscoveryRun[] = []
      for (let i = 0; i < config.repeats; i++) {
        const healthy = await phase(undefined, trustedFingerprint)
        if (
          !healthy.ready ||
          healthy.newErrors ||
          healthy.ui.fingerprint !== report.baselines[0].ui.fingerprint
        ) {
          report.failedControl = {
            ...healthy,
            reasons: {
              notReady: !healthy.ready,
              newErrors: healthy.newErrors,
              fingerprintChanged:
                healthy.ui.fingerprint !== report.baselines[0].ui.fingerprint,
            },
            diff: compareRegions(report.baselines[0].ui, healthy.ui),
          }
          throw new Error('CONTROL_UNSTABLE')
        }
        const result = await phase(experiment)
        const run: DiscoveryRun = {
          ...result,
          control: { ui: healthy.ui, snapshot: healthy.snapshot },
          observation: {
            ...compareRegions(healthy.ui, result.ui),
            injected: result.snapshot.injected,
            channels: result.snapshot.channels,
            recoveryMs: result.recoveryMs,
            repeatedReads: result.repeatedReads,
          },
          interpretation: classifyObservation({
            baseline: healthy.ui,
            final: result.ui,
            injected: result.snapshot.injected,
            expected: experiment.times,
            recovered: result.ready,
            newErrors: result.newErrors,
          }),
          ...(await screenshotRun(screenshot, page, `${id}-run${i + 1}`)),
        }
        runs.push(run)
        report.results.push(run)
      }
      const consistent = runs.every(
        (r) =>
          r.interpretation.classification ===
          runs[0].interpretation.classification,
      )
      report.findings.push({
        id,
        ...experiment,
        ...(consistent
          ? runs[0].interpretation
          : {
              classification: 'UNSTABLE',
              kind: 'inconclusive',
              confidence: 'low',
            }),
        confirmations: runs.length,
        repeatConfirmed: consistent && runs.length === 3,
        advice:
          'Inspect this structural difference against product expectations. Rerun the saved scenario after any local fix; disappearance of a heuristic is not proof of a fix.',
      })
    }
  } catch (error) {
    report.error = (error as Error).message
  } finally {
    try {
      const cleanup = await phase(undefined, trustedFingerprint)
      report.cleanup = cleanup
      report.finalReset =
        trustedFingerprint !== undefined &&
        cleanup.ready &&
        !cleanup.newErrors &&
        cleanup.ui.fingerprint === trustedFingerprint
          ? 'healthy'
          : 'not-verified'
    } catch (error) {
      report.cleanupError = (error as Error).message
    }
    try {
      // The window state is recorded as soon as visibility is prepared.
      if (visibility) report.window!.restoration = await visibility.revert()
    } catch (error) {
      report.windowRestoreError = (error as Error).message
    }
    page.off('pageerror', onError)
  }
  report.coverage = [...coverage.values()]
  report.ok =
    !report.error &&
    !report.cleanupError &&
    !report.windowRestoreError &&
    report.finalReset === 'healthy' &&
    report.findings.every((f) => f.kind === 'observation')
  retainPartialFindings(report, config.repeats)
  return report
}
