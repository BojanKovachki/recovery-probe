import { performance } from 'node:perf_hooks'
import type { Page } from 'playwright'
import {
  callsGap,
  findingId,
  laterCalls,
  matchesHealthyControl,
  retainPartialFindings,
  type DiscoveryExperiment,
  type DiscoveryFinding,
} from './experiment.mjs'
import { screenshotRun, type DiscoveryScreenshot } from './screenshots.mjs'
import {
  classifyObservation,
  compareRegions,
  readRegion,
  summarizeRegion,
  type RegionSummary,
} from '../../core/screen.mjs'
import {
  prepareVisibility,
  windowVisibility,
  type WindowVisibility,
} from '../../targets/visibility.mjs'
import type { IpcInspector } from '../../transports/ipc/inspector.mjs'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface ReadStats {
  realCalls: number
  successes: number
  errors: number
  pending: number
}

/** Call counters of one load, in the shape both transports report. */
export interface ReadSnapshot {
  injected: number
  injectedAt: number | null
  successfulAfterFault: number
  injectionError?: boolean
  channels: Record<string, ReadStats>
}

/** Arms a plan for the next load and reports its calls; see transports/session.mts. */
export interface ReadSession<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  begin(plan: { fault?: Fault; times?: number; skip?: number }): Promise<void>
  snapshot(): Snapshot | Promise<Snapshot>
  stop(): Promise<unknown>
}

export interface DiscoverySetup<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  page: Page
  session: ReadSession<Fault, Snapshot>
  /** The selected read and the others the screen needs, as named in snapshots. */
  read: string
  dependencies: string[]
  /** What this transport calls a read in reports. */
  readKind: 'channel' | 'endpoint'
  /** The error when a real read of the target fails. */
  readFailed: string
  experiments: DiscoveryExperiment<Fault>[]
  /** The fault for the later-call experiments; none when the transport can't let calls through. */
  laterCallFault?: Fault
  /** Gives the IPC hook's view of the window when the app has one. */
  control?: IpcInspector
  /** How to rerun the same experiments after a fix. */
  verification: string
}

export interface DiscoveryTiming {
  baselineTimeoutMs: number
  /** How long a faulted load is watched after the first fault. */
  observationMs: number
  settleMs: number
  repeats: number
  regionSelector?: string
  restoreWindow: boolean
}

export interface DiscoveryEvent<Snapshot extends ReadSnapshot> {
  elapsedMs: number
  injected: number
  channels: Snapshot['channels']
  ui: RegionSummary
  uncaughtErrors: number
}

export interface DiscoveryPhase<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  elapsedMs: number
  fault: Fault | 'healthy'
  times: number
  /** The call of the load that failed, when it was not the first. */
  call?: number
  screenshot?: string
  evidenceCaptureFailed?: true
  ready: boolean
  ui: RegionSummary
  snapshot: Snapshot
  timeline: DiscoveryEvent<Snapshot>[]
  newErrors: number
  recoveryDetectedAt: number | null
  recoveryMs: number | null
  timingNote: string
  repeatedReads: ({
    code: 'REPEATED_READS'
    count: number
    redundant: 'not-established'
  } & Partial<Record<'channel' | 'endpoint', string>>)[]
}

type Assessment = ReturnType<typeof classifyObservation>

export interface DiscoveryRun<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> extends DiscoveryPhase<Fault, Snapshot> {
  control: { ui: RegionSummary; snapshot: Snapshot }
  /** The same as interpretation; kept for reports that read it. */
  assessment: Assessment
  observation: ReturnType<typeof compareRegions> & {
    injected: number
    channels: Snapshot['channels']
    recoveryMs: number | null
    repeatedReads: DiscoveryPhase<Fault, Snapshot>['repeatedReads']
  }
  interpretation: Assessment
}

type PreparedVisibility = Awaited<ReturnType<typeof prepareVisibility>>

/** The fields discovery fills in; each transport adds its own around them. */
export interface DiscoveryResult<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  baselines: DiscoveryPhase<Fault, Snapshot>[]
  results: DiscoveryRun<Fault, Snapshot>[]
  findings: DiscoveryFinding[]
  finalReset: 'healthy' | 'not-verified'
  ok: boolean
  readiness: {
    calibrationComplete: boolean
    /** How often each healthy calibration load read the target. */
    callsPerLoad?: number[]
    callsGap?: string
  }
  window?: {
    initial: WindowVisibility
    restoration?: Awaited<ReturnType<PreparedVisibility['revert']>>
  }
  environment?: WindowVisibility & { online: boolean; ui: RegionSummary }
  stoppedObservation?: {
    reason: string
    fault: Fault | 'healthy'
    times: number
    snapshot: Snapshot | undefined
    ui: RegionSummary | undefined
    timeline: DiscoveryEvent<Snapshot>[]
  }
  failedControl?: DiscoveryPhase<Fault, Snapshot> & {
    reasons: {
      notReady: boolean
      newErrors: number
      fingerprintChanged: boolean
    }
    diff: ReturnType<typeof compareRegions>
  }
  cleanup?: DiscoveryPhase<Fault, Snapshot>
  error?: string
  cleanupError?: string
  windowRestoreError?: string
}

const advice = (classification: string) =>
  classification === 'SILENT_EMPTY'
    ? 'Inspect the error-to-empty UI branch. Preserve the distinction between a failed read and a successful empty result; consider an error message and retry action. This is a hypothesis to review locally.'
    : 'Review the recorded behaviour against product expectations. A finite retry limit or explicit error state is not automatically a defect.'

/**
 * Calibrates three healthy loads, then fails the selected read in each planned
 * way, with a healthy control before every faulted load, and fills `report`.
 */
export async function runDiscovery<
  Fault extends string,
  Snapshot extends ReadSnapshot,
>(
  setup: DiscoverySetup<Fault, Snapshot>,
  timing: DiscoveryTiming,
  report: DiscoveryResult<Fault, Snapshot>,
  { screenshot }: { screenshot?: DiscoveryScreenshot } = {},
): Promise<void> {
  const { page, session, read, dependencies, control } = setup
  const { baselineTimeoutMs, observationMs, settleMs } = timing
  const initialUrl = page.url()
  let errors = 0,
    trustedFingerprint: string | undefined,
    visibility: PreparedVisibility | undefined
  const onError = () => errors++
  page.on('pageerror', onError)

  const screen = async () => {
    const summary = summarizeRegion(
      await page.evaluate(readRegion, timing.regionSelector),
    )
    if (!summary.visible || !summary.online) {
      report.environment = {
        ...(await windowVisibility(page, control)),
        online: summary.online,
        ui: summary,
      }
      throw new Error('ENVIRONMENT_BLOCKED: ' + report.environment.diagnosis)
    }
    if (page.url() !== initialUrl) throw new Error('TARGET_NAVIGATED')
    return summary
  }

  // One reload: healthy, or with the experiment's faults armed.
  const load = async (
    experiment: DiscoveryExperiment<Fault> | undefined,
    expectedFingerprint?: string,
    calibrate = false,
  ): Promise<DiscoveryPhase<Fault, Snapshot>> => {
    const { fault, times = 1, call } = experiment ?? {}
    const started = performance.now()
    const initialErrors = errors
    const timeline: DiscoveryEvent<Snapshot>[] = []
    let stableSince = started,
      previous: string | undefined,
      previousEvent: string | undefined,
      snapshot: Snapshot | undefined,
      summary: RegionSummary | undefined,
      firstInjection: number | undefined
    try {
      await session.begin(
        fault ? { fault, times, ...(call ? { skip: call - 1 } : {}) } : {},
      )
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: baselineTimeoutMs,
      })
      while (true) {
        const current = await session.snapshot()
        snapshot = current
        if (current.injectionError) throw new Error('INJECTION_ERROR')
        if (current.injected && firstInjection === undefined)
          firstInjection = performance.now()
        const ui = await screen()
        summary = ui
        const signature = JSON.stringify(ui)
        if (signature !== previous) {
          previous = signature
          stableSince = performance.now()
        }
        const event = {
          elapsedMs: Math.round(performance.now() - started),
          injected: current.injected,
          channels: current.channels,
          ui,
          uncaughtErrors: errors - initialErrors,
        }
        // Bound reports without capturing payloads, filenames, error messages or stacks.
        const eventSignature = JSON.stringify({ ...event, elapsedMs: 0 })
        if (timeline.length < 100 && eventSignature !== previousEvent) {
          timeline.push(event)
          previousEvent = eventSignature
        }
        const target = current.channels[read]
        const needed = dependencies.map((d) => current.channels[d])
        if (needed.some((row) => row.errors))
          throw new Error('DEPENDENCY_FAILED')
        if (target.errors) throw new Error(setup.readFailed)
        const settled =
          target.pending === 0 &&
          needed.every((row) => row.successes > 0 && row.pending === 0)
        const ready =
          matchesHealthyControl(ui, expectedFingerprint) &&
          settled &&
          !ui.loading &&
          performance.now() - stableSince >= settleMs &&
          target.successes > 0 &&
          (!fault ||
            (current.injected === times &&
              current.successfulAfterFault > 0 &&
              ui.fingerprint === trustedFingerprint))
        const elapsed = performance.now() - (firstInjection ?? started)
        if (
          (!calibrate && ready) ||
          elapsed >=
            (firstInjection === undefined ? baselineTimeoutMs : observationMs)
        ) {
          const detectedAt = Date.now()
          const recovered = Boolean(fault) && ready
          return {
            elapsedMs: Math.round(performance.now() - started),
            fault: fault ?? 'healthy',
            times: fault ? times : 0,
            ...(call ? { call } : {}),
            ready,
            ui,
            snapshot: current,
            timeline,
            newErrors: errors - initialErrors,
            recoveryDetectedAt: recovered ? detectedAt : null,
            recoveryMs: recovered
              ? detectedAt - (current.injectedAt ?? detectedAt)
              : null,
            timingNote: `Sampled recovery with ${settleMs}ms UI stability; bounded observation starts at first observed injection.`,
            repeatedReads: Object.entries(current.channels)
              .filter(([, row]) => row.realCalls > 1)
              .map(([name, row]) => ({
                code: 'REPEATED_READS' as const,
                [setup.readKind]: name,
                count: row.realCalls,
                redundant: 'not-established' as const,
              })),
          }
        }
        await sleep(100)
      }
    } catch (error) {
      report.stoppedObservation ??= {
        reason: (error as Error).message,
        fault: fault ?? 'healthy',
        times,
        snapshot,
        ui: summary,
        timeline,
      }
      throw error
    } finally {
      await session.stop()
    }
  }

  const calibrate = async () => {
    for (let i = 0; i < 3; i++) {
      const baseline = await load(undefined, undefined, true)
      if (i === 0)
        Object.assign(
          baseline,
          await screenshotRun(screenshot, page, 'baseline'),
        )
      report.baselines.push(baseline)
      if (!baseline.ready || baseline.newErrors)
        throw new Error('BASELINE_NOT_HEALTHY')
    }
    const [first] = report.baselines
    if (
      !report.baselines.every((b) => b.ui.fingerprint === first.ui.fingerprint)
    )
      throw new Error('BASELINE_UNSTABLE')
    trustedFingerprint = first.ui.fingerprint
    report.readiness.calibrationComplete = true
    const callsPerLoad = report.baselines.map(
      (b) => b.snapshot.channels[read].realCalls,
    )
    report.readiness.callsPerLoad = callsPerLoad
    report.readiness.callsGap = callsGap(
      callsPerLoad,
      setup.laterCallFault !== undefined,
    )
  }

  // A healthy control before every faulted load also clears the previous state.
  const healthyControl = async () => {
    const healthy = await load(undefined, trustedFingerprint)
    const fingerprintChanged =
      healthy.ui.fingerprint !== report.baselines[0].ui.fingerprint
    if (!healthy.ready || healthy.newErrors || fingerprintChanged) {
      report.failedControl = {
        ...healthy,
        reasons: {
          notReady: !healthy.ready,
          newErrors: healthy.newErrors,
          fingerprintChanged,
        },
        diff: compareRegions(report.baselines[0].ui, healthy.ui),
      }
      throw new Error('CONTROL_UNSTABLE')
    }
    return healthy
  }

  const experiment = async (planned: DiscoveryExperiment<Fault>) => {
    const id = findingId(planned)
    const runs: DiscoveryRun<Fault, Snapshot>[] = []
    for (let i = 0; i < timing.repeats; i++) {
      const healthy = await healthyControl()
      const result = await load(planned)
      const assessment = classifyObservation({
        baseline: healthy.ui,
        final: result.ui,
        injected: result.snapshot.injected,
        expected: planned.times,
        recovered: result.ready,
        newErrors: result.newErrors,
      })
      const run: DiscoveryRun<Fault, Snapshot> = {
        ...result,
        control: { ui: healthy.ui, snapshot: healthy.snapshot },
        assessment,
        observation: {
          ...compareRegions(healthy.ui, result.ui),
          injected: result.snapshot.injected,
          channels: result.snapshot.channels,
          recoveryMs: result.recoveryMs,
          repeatedReads: result.repeatedReads,
        },
        interpretation: assessment,
        ...(await screenshotRun(screenshot, page, `${id}-run${i + 1}`)),
      }
      runs.push(run)
      report.results.push(run)
    }
    const consistent = runs.every(
      (r) => r.assessment.classification === runs[0].assessment.classification,
    )
    const assessment = consistent
      ? runs[0].assessment
      : { classification: 'UNSTABLE', kind: 'inconclusive', confidence: 'low' }
    report.findings.push({
      id,
      ...planned,
      ...assessment,
      confirmations: runs.length,
      repeatConfirmed: consistent && runs.length >= 3,
      observationMs,
      advice: advice(assessment.classification),
      verification: setup.verification,
    })
  }

  try {
    visibility = await prepareVisibility(page, {
      restoreWindow: timing.restoreWindow,
      control,
    })
    report.window = { initial: visibility.initial }
    await screen()
    try {
      await calibrate()
      const callsPerLoad = report.readiness.callsPerLoad!
      const later =
        setup.laterCallFault === undefined
          ? []
          : laterCalls(callsPerLoad).map((call) => ({
              fault: setup.laterCallFault!,
              times: 1,
              call,
            }))
      for (const planned of [...setup.experiments, ...later])
        await experiment(planned)
    } catch (error) {
      report.error = (error as Error).message
    } finally {
      try {
        const cleanup = await load(undefined, trustedFingerprint)
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
    }
  } catch (error) {
    report.error ??= (error as Error).message
  } finally {
    try {
      await session.stop()
    } catch (error) {
      report.finalReset = 'not-verified'
      report.cleanupError ??= (error as Error).message
    }
    try {
      // The window state is recorded as soon as visibility is prepared.
      if (visibility) report.window!.restoration = await visibility.revert()
    } catch (error) {
      report.windowRestoreError = (error as Error).message
    }
    page.off('pageerror', onError)
  }
  report.ok =
    !report.error &&
    !report.cleanupError &&
    !report.windowRestoreError &&
    report.finalReset === 'healthy' &&
    report.findings.every((f) => f.kind === 'observation')
  retainPartialFindings(report, timing.repeats)
}
