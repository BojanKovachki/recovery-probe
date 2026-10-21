import { performance } from 'node:perf_hooks'
import type { Page } from 'playwright'
import {
  readRegion,
  summarizeRegion,
  compareRegions,
  type RegionSummary,
} from './ipc-observation.mjs'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Transport = 'http' | 'ipc'
type RefreshFault =
  | 'http-error'
  | 'connection-failure'
  | 'invalid-json'
  | 'rejection'
  | 'null-result'

export interface RefreshTrigger {
  type: 'dom-event'
  target: 'window'
  name: string
}

/** The validated configuration: an HTTP endpoint or an IPC channel to refresh. */
export type RefreshConfig = RefreshOptions &
  (
    | { transport: 'http'; endpoint: string; channel?: string }
    | { transport: 'ipc'; channel: string; endpoint?: string }
  )

interface RefreshOptions {
  transport: Transport
  cdp: string
  inspector: string
  page?: number
  pageUrl?: string
  requiredEndpoints: string[]
  requiredChannels: string[]
  trigger: RefreshTrigger
  fault: RefreshFault
  times: number
  repeats: number
  baselineTimeoutMs: number
  observationMs: number
  idleMs: number
  settleMs: number
  secondTrigger: boolean
  regionSelector?: string
  restoreWindow: boolean
}

export function refreshConfig(input: object): RefreshConfig {
  const c: Record<string, unknown> = {
    transport: undefined,
    cdp: 'http://127.0.0.1:9222',
    inspector: 'http://127.0.0.1:9229',
    page: undefined,
    pageUrl: undefined,
    endpoint: undefined,
    requiredEndpoints: [],
    channel: undefined,
    requiredChannels: [],
    trigger: undefined,
    fault: undefined,
    times: 1,
    repeats: 3,
    baselineTimeoutMs: 15000,
    observationMs: 15000,
    idleMs: 1000,
    settleMs: 800,
    secondTrigger: false,
    regionSelector: undefined,
    restoreWindow: false,
  }
  for (const key of Object.keys(c))
    if (Object.hasOwn(input, key))
      c[key] = (input as Record<string, unknown>)[key]
  if (!['http', 'ipc'].includes(c.transport as string))
    throw Error('transport must be http or ipc')
  const trigger = c.trigger as Record<string, unknown> | null | undefined
  if (
    !trigger ||
    trigger.type !== 'dom-event' ||
    trigger.target !== 'window' ||
    typeof trigger.name !== 'string' ||
    !/^[a-zA-Z][\w:.-]{0,79}$/.test(trigger.name) ||
    Object.keys(trigger).some((k) => !['type', 'target', 'name'].includes(k))
  )
    throw Error(
      'Use an explicit trigger: {type: dom-event, target: window, name: online}',
    )
  if (
    typeof c.secondTrigger !== 'boolean' ||
    typeof c.restoreWindow !== 'boolean'
  )
    throw Error('Boolean options required')
  const faults: RefreshFault[] =
    c.transport === 'http'
      ? ['http-error', 'connection-failure', 'invalid-json']
      : ['rejection', 'null-result']
  c.fault ??= faults[0]
  if (!faults.includes(c.fault as RefreshFault))
    throw Error('Unsupported fault for transport')
  const names =
    c.transport === 'http'
      ? ['endpoint', 'requiredEndpoints']
      : ['channel', 'requiredChannels']
  const valid = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return false
    if (c.transport === 'ipc') return true
    try {
      const u = new URL(value)
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.href === value
      )
    } catch {
      return false
    }
  }
  const dependencies = c[names[1]]
  if (
    !valid(c[names[0]]) ||
    !Array.isArray(dependencies) ||
    !dependencies.every(valid) ||
    new Set([c[names[0]], ...dependencies]).size !== 1 + dependencies.length
  )
    throw Error('Provide a distinct target and known read dependencies')
  for (const [key, min, max] of [
    ['times', 1, 10],
    ['repeats', 1, 3],
    ['baselineTimeoutMs', 500, 30000],
    ['observationMs', 500, 30000],
    ['idleMs', 200, 10000],
    ['settleMs', 100, 5000],
  ] as const) {
    const value = c[key]
    if (
      !Number.isInteger(value) ||
      (value as number) < min ||
      (value as number) > max
    )
      throw Error(`Invalid ${key}`)
  }
  if (
    c.regionSelector !== undefined &&
    (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())
  )
    throw Error('Invalid regionSelector')
  return c as unknown as RefreshConfig
}

interface ReadRow {
  calls: number
  realCalls: number
  successes: number
  errors: number
  pending: number
}

/** What both transports report: per-read counts and the fault's progress. */
export interface RefreshSnapshot {
  channels: Record<string, ReadRow>
  injected: number
  successfulAfterFault: number
  injectionError?: boolean
}

/** An HTTP or IPC observer that the experiment arms, reads and stops. */
export interface RefreshAdapter {
  begin(fault?: {
    fault?: RefreshFault
    times?: number
    ttlMs?: number
  }): Promise<unknown>
  snapshot(): RefreshSnapshot | Promise<RefreshSnapshot>
  disarm(): Promise<unknown>
  stop(): Promise<unknown>
}

interface Sample {
  ui: RegionSummary
  snapshot: RefreshSnapshot
}

interface Observed extends Sample {
  elapsedMs: number
  timeline: (Sample & { elapsedMs: number })[]
  ready: boolean
}

interface Emitted {
  firedAt: number
  event: string
  synthesized: true
  online: boolean
  visibility: DocumentVisibilityState
}

type RefreshKind =
  'observation' | 'suspected-defect' | 'decision-needed' | 'inconclusive'

export interface RefreshRun {
  run: number
  requested: number
  observationMs: number
  attribution: { kind: 'temporal-association'; causalProof: false }
  stage: 'control' | 'fault' | 'second-trigger' | 'completed'
  healthy?: Observed
  idle?: Observed
  controlTrigger?: Emitted
  control?: Observed
  controlReads?: { read: string; calls: number }[]
  preFault?: Observed
  preFaultIdle?: Observed
  trigger?: Emitted
  spontaneous?: Observed
  injected?: number
  observation?: ReturnType<typeof compareRegions>
  subsequentRealReads?: number
  noSubsequentReadObserved?: boolean
  code?: string
  kind?: RefreshKind
  freshReadSucceeded?: boolean
  secondTrigger?: Emitted
  afterSecondTrigger?: Observed
  secondTriggerResult?:
    | 'RECOVERED_AFTER_TRIGGER'
    | 'NO_REFRESH_SUCCESS_OBSERVED'
    | 'NOT_RECOVERED_WITHIN_WINDOW'
  summary?: string
}

export interface RefreshFinding {
  id: string
  classification: string
  kind: RefreshKind
  completedRuns: number
  plannedRuns: number
  repeatConsistent: boolean
  repeatConfirmed: boolean
}

export interface RefreshReport {
  schemaVersion: 1
  mode: 'refresh experiment'
  trigger: RefreshTrigger & {
    synthesized: true
    changesNetworkState: false
  }
  readiness: {
    strategy: 'bounded-end-state-calibration'
    calibrationRuns: number
    calibrationWindowMs: number
    settleMs: number
    limitation: string
  }
  baselines: Observed[]
  results: RefreshRun[]
  findings: RefreshFinding[]
  ok: boolean
  finalReset: 'healthy' | 'not-verified'
  faultReset: 'healthy' | 'not-verified'
  limitation: string
  stoppedObservation?: Observed
  cleanup?: Observed
  error?: string
  cleanupError?: string
}

// Both transports supply begin/snapshot/disarm/stop. No reload occurs between
// the faulted refresh and its spontaneous/optional second-trigger observations.
export async function runRefresh(
  page: Page,
  input: object,
  adapter: RefreshAdapter,
  { signal }: { signal?: AbortSignal } = {},
): Promise<RefreshReport> {
  const c = refreshConfig(input),
    target = c.transport === 'http' ? c.endpoint : c.channel
  const required =
    c.transport === 'http' ? c.requiredEndpoints : c.requiredChannels
  const report: RefreshReport = {
    schemaVersion: 1,
    mode: 'refresh experiment',
    trigger: { ...c.trigger, synthesized: true, changesNetworkState: false },
    readiness: {
      strategy: 'bounded-end-state-calibration',
      calibrationRuns: 3,
      calibrationWindowMs: c.baselineTimeoutMs,
      settleMs: c.settleMs,
      limitation:
        'Matching stable end states do not prove completeness beyond the calibration window.',
    },
    baselines: [],
    results: [],
    findings: [],
    ok: false,
    finalReset: 'not-verified',
    faultReset: 'not-verified',
    limitation:
      'Synthetic window event only; no network outage, OS resume, token expiry or native transport is simulated. Timing establishes association, not causal proof. Trigger handlers may have application side effects. No recovery beyond the observation window is established.',
  }
  const initialUrl = page.url()
  let errors = 0
  const onError = () => errors++
  page.on('pageerror', onError)
  const checkAbort = () => {
    if (signal?.aborted) throw Error('ABORTED')
  }
  const sample = async (): Promise<Sample> => {
    if (page.url() !== initialUrl) throw Error('TARGET_NAVIGATED')
    const ui = summarizeRegion(
      await page.evaluate(readRegion, c.regionSelector),
    )
    if (!ui.visible || !ui.online) throw Error('ENVIRONMENT_BLOCKED')
    const snapshot = await adapter.snapshot()
    if (snapshot.injectionError) throw Error('INJECTION_ERROR')
    return { ui, snapshot }
  }
  const observe = async (
    ms: number,
    predicate?: (value: Sample, stable: boolean) => boolean,
    ignoreAbort = false,
    fullWindow = false,
  ): Promise<Observed> => {
    const start = performance.now(),
      timeline: Observed['timeline'] = []
    let last: Sample,
      previous: string | undefined,
      stableSince = start
    while (true) {
      if (!ignoreAbort) checkAbort()
      last = await sample()
      const signature = JSON.stringify(last.ui)
      if (signature !== previous) {
        previous = signature
        stableSince = performance.now()
      }
      const elapsedMs = Math.round(performance.now() - start)
      const event = { elapsedMs, ...last }
      if (
        timeline.length < 100 &&
        (JSON.stringify(timeline.at(-1)?.ui) !== signature ||
          JSON.stringify(timeline.at(-1)?.snapshot) !==
            JSON.stringify(last.snapshot))
      )
        timeline.push(event)
      const stable = performance.now() - stableSince >= c.settleMs
      if (!fullWindow && predicate?.(last, stable))
        return { ...last, elapsedMs, timeline, ready: true }
      if (performance.now() - start >= ms)
        return {
          ...last,
          elapsedMs,
          timeline,
          ready: Boolean(fullWindow && predicate?.(last, stable)),
        }
      await sleep(50)
    }
  }
  const settled = (s: RefreshSnapshot) =>
    Object.values(s.channels).every((r) => r.pending === 0)
  const healthy = (value: Sample, stable: boolean, expected?: string) =>
    stable &&
    !value.ui.loading &&
    !Object.values(value.snapshot.channels).some((r) => r.errors) &&
    settled(value.snapshot) &&
    value.snapshot.channels[target].successes > 0 &&
    required.every((k) => value.snapshot.channels[k].successes > 0) &&
    (!expected || value.ui.fingerprint === expected)
  const load = async (
    expected: string | undefined,
    ignoreAbort = false,
    calibrate = false,
  ) => {
    const initialErrors = errors
    await adapter.begin()
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: c.baselineTimeoutMs,
    })
    const result = await observe(
      c.baselineTimeoutMs,
      (v, stable) => healthy(v, stable, expected),
      ignoreAbort,
      calibrate,
    )
    if (errors !== initialErrors) result.ready = false
    return result
  }
  let baseline: Observed | undefined
  const quiet = async () => {
    await adapter.begin()
    const phase = await observe(c.idleMs)
    if (phase.snapshot.channels[target].calls || !settled(phase.snapshot)) {
      report.stoppedObservation = phase
      throw Error('ATTRIBUTION_AMBIGUOUS: target traffic during idle control')
    }
    if (baseline && phase.ui.fingerprint !== baseline.ui.fingerprint) {
      report.stoppedObservation = phase
      throw Error('CONTROL_UNSTABLE_DURING_IDLE')
    }
    return phase
  }
  const fire = async (): Promise<Emitted> => {
    checkAbort()
    const before = await sample()
    if (before.snapshot.channels[target].calls)
      throw Error('ATTRIBUTION_AMBIGUOUS: target read before trigger')
    const emitted = await page.evaluate((name) => {
      const firedAt = Date.now()
      window.dispatchEvent(new Event(name))
      return {
        firedAt,
        event: name,
        synthesized: true as const,
        online: navigator.onLine,
        visibility: document.visibilityState,
      }
    }, c.trigger.name)
    return emitted
  }
  try {
    for (let i = 0; i < 3; i++) {
      checkAbort()
      const b = await load(undefined, false, true)
      report.baselines.push(b)
      if (!b.ready || errors) throw Error('BASELINE_UNSTABLE')
    }
    if (
      !report.baselines.every(
        (b) => b.ui.fingerprint === report.baselines[0].ui.fingerprint,
      )
    )
      throw Error('BASELINE_UNSTABLE')
    // A const keeps its narrowing inside the predicates below.
    const base = report.baselines[0]
    baseline = base
    for (let i = 0; i < c.repeats; i++) {
      const row: RefreshRun = {
        run: i + 1,
        requested: c.times,
        observationMs: c.observationMs,
        attribution: { kind: 'temporal-association', causalProof: false },
        stage: 'control',
      }
      report.results.push(row)
      const initialErrors = errors
      const healthyRun = await load(base.ui.fingerprint)
      row.healthy = healthyRun
      if (!healthyRun.ready) throw Error('CONTROL_UNSTABLE')
      row.idle = await quiet()
      await adapter.begin()
      row.controlTrigger = await fire()
      const control = await observe(
        c.baselineTimeoutMs,
        (v, stable) =>
          stable &&
          !v.ui.loading &&
          settled(v.snapshot) &&
          v.snapshot.channels[target].successes > 0 &&
          v.ui.fingerprint === base.ui.fingerprint,
      )
      row.control = control
      if (!control.snapshot.channels[target].calls) {
        row.code = 'TRIGGER_NO_READ'
        row.kind = 'inconclusive'
        break
      }
      if (
        !control.ready ||
        Object.values(control.snapshot.channels).some((r) => r.errors)
      )
        throw Error('TRIGGER_CONTROL_UNSTABLE')
      row.controlReads = Object.entries(control.snapshot.channels)
        .filter(([, r]) => r.calls)
        .map(([read, r]) => ({ read, calls: r.calls }))
      const preFault = await load(base.ui.fingerprint)
      row.preFault = preFault
      if (!preFault.ready) throw Error('CONTROL_UNSTABLE')
      row.preFaultIdle = await quiet()
      await adapter.begin({
        fault: c.fault,
        times: c.times,
        ttlMs: c.observationMs + 5000,
      })
      row.stage = 'fault'
      row.trigger = await fire()
      const spontaneous = await observe(c.observationMs) // Never issue another trigger in this phase.
      row.spontaneous = spontaneous
      await adapter.disarm()
      report.faultReset = 'healthy'
      const s = spontaneous.snapshot
      row.injected = s.injected
      const observation = compareRegions(preFault.ui, spontaneous.ui)
      row.observation = observation
      row.subsequentRealReads = s.channels[target].realCalls
      row.noSubsequentReadObserved = row.subsequentRealReads === 0
      const recovered =
        s.successfulAfterFault > 0 &&
        spontaneous.ui.fingerprint === base.ui.fingerprint &&
        !spontaneous.ui.loading
      if (s.injected === 0) {
        row.code = 'TRIGGER_NO_READ'
        row.kind = 'inconclusive'
      } else if (s.injected !== c.times) {
        row.code = 'FAULT_NOT_TRIGGERED'
        row.kind = 'inconclusive'
      } else if (
        Object.values(s.channels).some((r) => r.errors) ||
        errors > initialErrors
      ) {
        row.code = 'EXPERIMENT_CONFOUNDED'
        row.kind = 'inconclusive'
      } else if (recovered) {
        row.code = 'RECOVERED_AUTOMATICALLY'
        row.kind = 'observation'
      } else if (observation.contentLoss) {
        row.code = 'CONTENT_LOSS_ON_REFRESH'
        row.kind = 'suspected-defect'
      } else if (spontaneous.ui.fingerprint === base.ui.fingerprint) {
        row.code = 'CONTENT_KEPT'
        row.kind = 'observation'
      } else {
        row.code = 'UI_DIFFERENCE_AT_DEADLINE'
        row.kind = 'decision-needed'
      }
      row.freshReadSucceeded = s.successfulAfterFault > 0
      if (c.secondTrigger && row.kind !== 'inconclusive') {
        if (!settled(s)) throw Error('PENDING_READS_BEFORE_SECOND_TRIGGER')
        await adapter.begin()
        row.stage = 'second-trigger'
        row.secondTrigger = await fire()
        const a = await observe(c.observationMs)
        row.afterSecondTrigger = a
        row.secondTriggerResult =
          a.snapshot.channels[target].successes > 0 &&
          a.ui.fingerprint === base.ui.fingerprint &&
          !a.ui.loading
            ? 'RECOVERED_AFTER_TRIGGER'
            : a.ui.fingerprint === base.ui.fingerprint
              ? 'NO_REFRESH_SUCCESS_OBSERVED'
              : 'NOT_RECOVERED_WITHIN_WINDOW'
        // This result never changes the spontaneous-phase classification.
      }
      row.stage = 'completed'
      row.summary = `After the synthetic ${c.trigger.name} event, ${row.injected}/${c.times} faults were consumed; ${row.code}. ${row.noSubsequentReadObserved ? 'No subsequent target read was observed' : 'Subsequent target reads were observed'} within ${c.observationMs} ms.`
    }
  } catch (error) {
    report.error = (error as Error).message
  } finally {
    let safe = false
    try {
      await adapter.disarm()
      report.faultReset = 'healthy'
      safe = true
    } catch (error) {
      report.cleanupError = (error as Error).message
    }
    if (safe && baseline)
      try {
        report.cleanup = await load(baseline.ui.fingerprint, true)
        report.finalReset = report.cleanup.ready ? 'healthy' : 'not-verified'
      } catch (error) {
        report.cleanupError = (error as Error).message
      }
    try {
      await adapter.stop()
    } catch (error) {
      report.cleanupError = (error as Error).message
      report.faultReset = 'not-verified'
    }
    page.off('pageerror', onError)
  }
  const completed = report.results.filter((r) => r.stage === 'completed')
  const consistent =
    completed.length === c.repeats &&
    completed.every((r) => r.code === completed[0].code)
  report.findings = [
    {
      id: `${c.trigger.name}-${c.fault}-${c.times}`,
      classification: consistent ? completed[0].code! : 'INCOMPLETE_EXPERIMENT',
      kind: consistent ? completed[0].kind! : 'inconclusive',
      completedRuns: completed.length,
      plannedRuns: c.repeats,
      repeatConsistent: consistent,
      repeatConfirmed:
        consistent && c.repeats === 3 && completed[0].kind !== 'inconclusive',
    },
  ]
  if (report.results[0]?.code === 'TRIGGER_NO_READ' && !completed.length)
    report.findings[0].classification = 'TRIGGER_NO_READ'
  report.ok =
    !report.error &&
    !report.cleanupError &&
    report.finalReset === 'healthy' &&
    report.faultReset === 'healthy' &&
    report.findings.every((f) => f.kind === 'observation')
  return report
}
