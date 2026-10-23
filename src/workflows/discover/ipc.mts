import { matchesHealthyControl, retainPartialFindings } from './experiment.mjs'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Browser, Page } from 'playwright'
import { connectDesktop, desktopPages } from '../../targets/cdp.mjs'
import {
  callsGap,
  findingId,
  laterCalls,
  type DiscoveryExperiment,
  type DiscoveryFinding,
} from './experiment.mjs'
import { screenshotRun, type DiscoveryScreenshot } from './screenshots.mjs'
import { connectIpcInspector } from '../../transports/ipc/inspector.mjs'
import {
  confirmSameWindow,
  resetIpcAndConfirm,
  waitForSettledCalls,
} from '../../transports/ipc/control.mjs'
import type { IpcFault } from '../../transports/ipc/control.mjs'
import type { IpcSnapshot } from '../../ipc-probe.cjs'
import {
  prepareVisibility,
  windowVisibility,
} from '../../targets/visibility.mjs'
import type { WindowVisibility } from '../../targets/visibility.mjs'
import {
  readRegion,
  summarizeRegion,
  classifyObservation,
  compareRegions,
} from '../../core/screen.mjs'
import type { RegionSummary } from '../../core/screen.mjs'

export interface IpcDiscoveryConfig {
  cdp: string
  inspector: string
  channel: string
  requiredChannels: string[]
  observationMs: number
  baselineTimeoutMs: number
  repeats: number
  settleMs: number
  regionSelector?: string
  restoreWindow: boolean
}

export type IpcDiscoveryInput = Partial<IpcDiscoveryConfig> &
  Pick<IpcDiscoveryConfig, 'channel'>

interface DiscoveryEvent {
  elapsedMs: number
  injected: number
  channels: IpcSnapshot['channels']
  ui: RegionSummary
  uncaughtErrors: number
}

type Experiment = DiscoveryExperiment<IpcFault>

interface DiscoveryPhase {
  elapsedMs: number
  fault: IpcFault | 'healthy'
  times: number
  /** The call of the load that failed, when it was not the first. */
  call?: number
  screenshot?: string
  evidenceCaptureFailed?: true
  ready: boolean
  ui: RegionSummary
  snapshot: IpcSnapshot
  timeline: DiscoveryEvent[]
  newErrors: number
  recoveryDetectedAt: number | null
  recoveryMs: number | null
  timingNote: string
  repeatedReads: {
    code: 'REPEATED_READS'
    channel: string
    count: number
    redundant: 'not-established'
  }[]
}

type Assessment = ReturnType<typeof classifyObservation>

interface DiscoveryRun extends DiscoveryPhase {
  control: { ui: RegionSummary; snapshot: IpcSnapshot }
  assessment: Assessment
  observation: ReturnType<typeof compareRegions> & {
    injected: number
    channels: IpcSnapshot['channels']
    recoveryMs: number | null
    repeatedReads: DiscoveryPhase['repeatedReads']
  }
  interpretation: Assessment
}

type PreparedVisibility = Awaited<ReturnType<typeof prepareVisibility>>

export interface IpcDiscoveryReport {
  schemaVersion: 2
  mode: string
  channel: string
  generatedAt: string
  baselines: DiscoveryPhase[]
  results: DiscoveryRun[]
  findings: DiscoveryFinding[]
  finalReset: 'healthy' | 'not-verified'
  ok: boolean
  readiness: {
    strategy: string
    calibrationRuns: number
    calibrationWindowMs: number
    calibrationComplete: boolean
    relevantChannels: string[]
    settleMs: number
    /** How often each healthy calibration load read the selected channel. */
    callsPerLoad?: number[]
    callsGap?: string
    note: string
  }
  limitation: string
  window?: {
    initial: WindowVisibility
    restoration?: Awaited<ReturnType<PreparedVisibility['revert']>>
  }
  coverage?: {
    watchedChannels: string[]
    unobservedRegisteredChannels: string[]
    gaps: string[]
  }
  environment?: WindowVisibility & { online: boolean; ui: RegionSummary }
  stoppedObservation?: {
    reason: string
    fault: IpcFault | 'healthy'
    times: number
    snapshot: IpcSnapshot | null | undefined
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export function discoveryConfig(input: IpcDiscoveryInput): IpcDiscoveryConfig {
  const c: Record<string, unknown> = {
    cdp: 'http://127.0.0.1:9222',
    inspector: 'http://127.0.0.1:9229',
    channel: undefined,
    requiredChannels: [],
    observationMs: 8000,
    baselineTimeoutMs: 15000,
    repeats: 3,
    settleMs: 800,
    regionSelector: undefined,
    restoreWindow: false,
  }
  for (const key of Object.keys(c))
    if (Object.hasOwn(input, key))
      c[key] = (input as Record<string, unknown>)[key]
  if (typeof c.channel !== 'string' || !c.channel.trim())
    throw new Error('channel is required (an explicitly allowed read channel)')
  if (
    !Array.isArray(c.requiredChannels) ||
    c.requiredChannels.some(
      (x) => typeof x !== 'string' || !x.trim() || x === c.channel,
    ) ||
    new Set(c.requiredChannels).size !== c.requiredChannels.length
  )
    throw new Error('Invalid requiredChannels')
  for (const key of ['observationMs', 'baselineTimeoutMs'])
    if (
      typeof c[key] !== 'number' ||
      !Number.isInteger(c[key]) ||
      c[key] < 500 ||
      c[key] > 30000
    )
      throw new Error(`${key} must be 500–30000`)
  if (
    typeof c.repeats !== 'number' ||
    !Number.isInteger(c.repeats) ||
    c.repeats < 1 ||
    c.repeats > 3
  )
    throw new Error('repeats must be 1–3')
  if (
    typeof c.settleMs !== 'number' ||
    !Number.isInteger(c.settleMs) ||
    c.settleMs < 200 ||
    c.settleMs > 5000
  )
    throw new Error('settleMs must be 200–5000')
  if (
    c.regionSelector !== undefined &&
    (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())
  )
    throw new Error('Invalid regionSelector')
  if (typeof c.restoreWindow !== 'boolean')
    throw new Error('restoreWindow must be boolean')
  return c as unknown as IpcDiscoveryConfig
}
export async function discoverIpc(
  input: IpcDiscoveryInput,
  { screenshot }: { screenshot?: DiscoveryScreenshot } = {},
): Promise<IpcDiscoveryReport> {
  const config = discoveryConfig(input)
  const report: IpcDiscoveryReport = {
    schemaVersion: 2,
    mode: 'experimental IPC discovery',
    channel: config.channel,
    generatedAt: new Date().toISOString(),
    baselines: [],
    results: [],
    findings: [],
    finalReset: 'not-verified',
    ok: false,
    readiness: {
      strategy: 'bounded-end-state-calibration',
      calibrationRuns: 3,
      calibrationWindowMs: config.baselineTimeoutMs,
      calibrationComplete: false,
      relevantChannels: [config.channel, ...config.requiredChannels],
      settleMs: config.settleMs,
      note: 'Relevant channels are explicit. Matching stable end states do not prove completeness beyond the calibration window.',
    },
    limitation:
      'One explicitly allowed IPC read on the current screen. Synthetic renderer-boundary faults only. Structural changes and language hints produce leads, not proven product defects. No source repair, automatic navigation, HTTP/Rust coverage or uploads. UI text and repeated values are compared transiently; only hashes, structural shapes and counts are saved.',
  }
  const control = await connectIpcInspector(config.inspector)
  let browser: Browser | undefined,
    watchedPage: Page | undefined,
    runId: string | undefined,
    visibility: PreparedVisibility | undefined,
    trustedFingerprint: string | undefined
  const settleMs = config.settleMs
  let errorCount = 0
  const onError = () => {
    errorCount++
  }
  try {
    const identity = await control.call('identify')
    if (!(identity.capabilities?.maxFaultCount >= 2))
      throw new Error(
        'Restart the app with the preview.6 or newer hook; repeated faults are unsupported by the loaded hook',
      )
    for (const ch of [config.channel, ...config.requiredChannels])
      if (!identity.registered.includes(ch))
        throw new Error('Channel not captured: ' + ch)
    browser = await connectDesktop(config.cdp)
    const pages = desktopPages(browser).filter(
      (p) => p.url() === identity.pageUrl,
    )
    if (pages.length !== 1)
      throw new Error('Keep one matching target window open')
    const page = pages[0]
    await confirmSameWindow(page, control)
    visibility = await prepareVisibility(page, {
      restoreWindow: config.restoreWindow,
      control,
    })
    report.window = { initial: visibility.initial }
    report.coverage = {
      watchedChannels: [config.channel, ...config.requiredChannels],
      unobservedRegisteredChannels: identity.registered.filter(
        (c) => ![config.channel, ...config.requiredChannels].includes(c),
      ),
      gaps: [
        'Only explicitly watched channels are observed; native and other channels are unmeasured.',
        'Argument-level methods within multiplexed IPC channels are not identified or separately faulted.',
      ],
    }
    page.on('pageerror', onError)
    watchedPage = page
    const observe = async () => {
      const summary = summarizeRegion(
        await page.evaluate(readRegion, config.regionSelector),
      )
      if (!summary.visible || !summary.online) {
        report.environment = {
          ...(await windowVisibility(page, control)),
          online: summary.online,
          ui: summary,
        }
        throw new Error('ENVIRONMENT_BLOCKED: ' + report.environment.diagnosis)
      }
      if (page.url() !== identity.pageUrl) throw new Error('TARGET_NAVIGATED')
      return summary
    }
    await observe()
    const phase = async (
      experiment: Experiment | undefined,
      expectedFingerprint?: string,
      calibrate = false,
    ): Promise<DiscoveryPhase> => {
      const { fault, times = 1, call } = experiment ?? {}
      // An app retry can still be in flight after a faulted run.
      await waitForSettledCalls(control, config.baselineTimeoutMs)
      runId = randomUUID()
      const id = runId
      const started = performance.now()
      const initialErrors = errorCount
      const timeline: DiscoveryEvent[] = []
      let stableSince = performance.now(),
        previous: string | undefined,
        snapshot: IpcSnapshot | null | undefined,
        summary: RegionSummary | undefined,
        firstInjectionObserved: number | undefined,
        previousEvent: string | undefined
      try {
        await control.call('begin', {
          id,
          channel: config.channel,
          requiredChannels: config.requiredChannels,
          ...(fault
            ? { fault, times, ...(call ? { skip: call - 1 } : {}) }
            : {}),
          ttlMs: config.baselineTimeoutMs + config.observationMs,
        })
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: config.baselineTimeoutMs,
        })
        while (true) {
          snapshot = await control.call('snapshot')
          if (snapshot?.id !== id || snapshot.senderId !== identity.senderId)
            throw new Error('Probe run or target changed')
          if (snapshot.injected && firstInjectionObserved === undefined)
            firstInjectionObserved = performance.now()
          summary = await observe()
          const signature = JSON.stringify(summary)
          if (signature !== previous) {
            previous = signature
            stableSince = performance.now()
          }
          const target = snapshot.channels[config.channel]
          const dependencies = config.requiredChannels.map(
            (ch) => snapshot!.channels[ch],
          )
          if (dependencies.some((row) => row.errors))
            throw new Error('DEPENDENCY_FAILED')
          if (target.errors) throw new Error('REAL_HANDLER_FAILED')

          const event = {
            elapsedMs: Math.round(performance.now() - started),
            injected: snapshot.injected,
            channels: snapshot.channels,
            ui: summary,
            uncaughtErrors: errorCount - initialErrors,
          }
          // Bound reports without capturing payloads, filenames, error messages or stacks.
          const eventSignature = JSON.stringify({ ...event, elapsedMs: 0 })
          if (timeline.length < 100 && eventSignature !== previousEvent) {
            timeline.push(event)
            previousEvent = eventSignature
          }
          const settled =
            target.pending === 0 &&
            dependencies.every((row) => row.successes > 0 && !row.pending)
          const stable =
            performance.now() - stableSince >= settleMs && !summary.loading
          const ready =
            matchesHealthyControl(summary, expectedFingerprint) &&
            settled &&
            stable &&
            target.successes >= 1 &&
            (!fault ||
              (snapshot.injected === times &&
                snapshot.successfulAfterFault > 0 &&
                summary.fingerprint === trustedFingerprint))
          const elapsed =
            firstInjectionObserved === undefined
              ? performance.now() - started
              : performance.now() - firstInjectionObserved
          if (
            (!calibrate && ready) ||
            elapsed >=
              (fault && firstInjectionObserved !== undefined
                ? config.observationMs
                : config.baselineTimeoutMs)
          ) {
            const detectedAt = Date.now()
            return {
              elapsedMs: Math.round(performance.now() - started),
              fault: fault ?? 'healthy',
              times: fault ? times : 0,
              ...(call ? { call } : {}),
              ready,
              ui: summary,
              snapshot,
              timeline,
              newErrors: errorCount - initialErrors,
              recoveryDetectedAt: fault && ready ? detectedAt : null,
              recoveryMs:
                fault && ready ? detectedAt - snapshot.injectedAt! : null,
              timingNote: `Sampled recovery with ${settleMs}ms UI stability; bounded observation starts at first observed injection.`,
              repeatedReads: Object.entries(snapshot.channels)
                .filter(([, row]) => row.realCalls > 1)
                .map(([channel, row]) => ({
                  code: 'REPEATED_READS',
                  channel,
                  count: row.realCalls,
                  redundant: 'not-established',
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
        await resetIpcAndConfirm(control, id)
      }
    }
    try {
      for (let i = 0; i < 3; i++) {
        const baseline = await phase(undefined, undefined, true)
        if (i === 0)
          Object.assign(
            baseline,
            await screenshotRun(screenshot, page, 'baseline'),
          )
        report.baselines.push(baseline)
        if (!baseline.ready || baseline.newErrors)
          throw new Error('BASELINE_NOT_HEALTHY')
      }
      if (
        !report.baselines.every(
          (b) => b.ui.fingerprint === report.baselines[0].ui.fingerprint,
        )
      )
        throw new Error(
          'BASELINE_UNSTABLE: automatic text comparison is unsuitable; use explicit ipc checks',
        )
      trustedFingerprint = report.baselines[0].ui.fingerprint
      report.readiness.calibrationComplete = true
      const callsPerLoad = report.baselines.map(
        (b) => b.snapshot.channels[config.channel].realCalls,
      )
      const canSkip = identity.capabilities.faultSkip === true
      report.readiness.callsPerLoad = callsPerLoad
      report.readiness.callsGap = callsGap(callsPerLoad, canSkip)
      const calls = canSkip ? laterCalls(callsPerLoad) : []
      const experiments: Experiment[] = [
        { fault: 'rejection', times: 1 },
        { fault: 'rejection', times: 2 },
        { fault: 'null-result', times: 1 },
        ...calls.map((call) => ({
          fault: 'rejection' as const,
          times: 1,
          call,
        })),
      ]
      for (const experiment of experiments) {
        const id = findingId(experiment)
        const runs: DiscoveryRun[] = []
        for (let i = 0; i < config.repeats; i++) {
          // A healthy control before every faulted run also clears the previous state.
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
          const assessment = classifyObservation({
            baseline: healthy.ui,
            final: result.ui,
            injected: result.snapshot.injected,
            expected: experiment.times,
            recovered: result.ready,
            newErrors: result.newErrors,
          })
          const run: DiscoveryRun = {
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
          (r) =>
            r.assessment.classification === runs[0].assessment.classification,
        )
        const assessment = consistent
          ? runs[0].assessment
          : { classification: 'UNSTABLE', kind: 'inconclusive' }
        report.findings.push({
          id,
          ...experiment,
          ...assessment,
          confirmations: runs.length,
          repeatConfirmed: consistent && runs.length >= 3,
          observationMs: config.observationMs,
          advice:
            assessment.classification === 'SILENT_EMPTY'
              ? 'Inspect the error-to-empty UI branch. Preserve the distinction between a failed read and a successful empty result; consider an error message and retry action. This is a hypothesis to review locally.'
              : 'Review the recorded behaviour against product expectations. A finite retry limit or explicit error state is not automatically a defect.',
          verification:
            'Rerun the saved scenario with ipc --discover after the local change. Compare this experiment and its healthy controls; a disappeared warning alone does not prove a fix.',
        })
      }
    } catch (error) {
      report.error = (error as Error).message
    } finally {
      try {
        if (runId) await resetIpcAndConfirm(control, runId)
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
    }
    report.ok =
      !report.error &&
      report.finalReset === 'healthy' &&
      report.findings.every((f) => f.kind === 'observation')
  } catch (error) {
    report.error = (error as Error).message
  } finally {
    try {
      if (runId) await resetIpcAndConfirm(control, runId)
    } catch (error) {
      report.ok = false
      report.finalReset = 'not-verified'
      report.cleanupError = (error as Error).message
    }
    try {
      if (visibility) report.window!.restoration = await visibility.revert()
    } catch (error) {
      report.ok = false
      report.windowRestoreError = (error as Error).message
    }
    watchedPage?.off('pageerror', onError)
    control.close()
    if (browser) await browser.close()
  }
  retainPartialFindings(report, config.repeats)
  return report
}
