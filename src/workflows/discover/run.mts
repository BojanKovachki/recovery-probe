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
  type PreparedVisibility,
} from '../../targets/visibility.mjs'
import {
  callsGap,
  findingId,
  laterCalls,
  retainPartialFindings,
  type DiscoveryExperiment,
} from './experiment.mjs'
import { load, type LoadContext, type LoadPlan } from './load.mjs'
import { screenshotRun, type DiscoveryScreenshot } from './screenshots.mjs'
import type {
  DiscoveryPhase,
  DiscoveryResult,
  DiscoveryRun,
  DiscoverySetup,
  DiscoveryTiming,
  ReadSnapshot,
} from './types.mjs'

const CALIBRATION_LOADS = 3

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
  await new Discovery(setup, timing, report, screenshot).run()
}

class Discovery<Fault extends string, Snapshot extends ReadSnapshot> {
  readonly #setup: DiscoverySetup<Fault, Snapshot>
  readonly #timing: DiscoveryTiming
  readonly #report: DiscoveryResult<Fault, Snapshot>
  readonly #screenshot?: DiscoveryScreenshot
  readonly #initialUrl: string
  readonly #loads: LoadContext<Fault, Snapshot>
  #errors = 0
  #trustedFingerprint?: string
  #visibility?: PreparedVisibility
  #countError = () => this.#errors++

  constructor(
    setup: DiscoverySetup<Fault, Snapshot>,
    timing: DiscoveryTiming,
    report: DiscoveryResult<Fault, Snapshot>,
    screenshot: DiscoveryScreenshot | undefined,
  ) {
    this.#setup = setup
    this.#timing = timing
    this.#report = report
    this.#screenshot = screenshot
    this.#initialUrl = setup.page.url()
    this.#loads = {
      setup,
      timing,
      report,
      screen: () => this.#screen(),
      errors: () => this.#errors,
      trustedFingerprint: () => this.#trustedFingerprint,
    }
  }

  async run() {
    const { page, control } = this.#setup
    page.on('pageerror', this.#countError)
    try {
      this.#visibility = await prepareVisibility(page, {
        restoreWindow: this.#timing.restoreWindow,
        control,
      })
      this.#report.window = { initial: this.#visibility.initial }
      await this.#screen()
      await this.#experimentThenReset()
    } catch (error) {
      this.#report.error ??= (error as Error).message
    } finally {
      await this.#release()
    }
    this.#conclude()
  }

  #load(plan?: LoadPlan<Fault>) {
    return load(this.#loads, plan)
  }

  async #screen(): Promise<RegionSummary> {
    const { page, control } = this.#setup
    const summary = summarizeRegion(
      await page.evaluate(readRegion, this.#timing.regionSelector),
    )
    if (!summary.visible || !summary.online) {
      this.#report.environment = {
        ...(await windowVisibility(page, control)),
        online: summary.online,
        ui: summary,
      }
      throw new Error(
        'ENVIRONMENT_BLOCKED: ' + this.#report.environment.diagnosis,
      )
    }
    if (page.url() !== this.#initialUrl) throw new Error('TARGET_NAVIGATED')
    return summary
  }

  async #experimentThenReset() {
    try {
      await this.#calibrate()
      for (const planned of this.#planned()) await this.#experiment(planned)
    } catch (error) {
      this.#report.error = (error as Error).message
    } finally {
      await this.#reset()
    }
  }

  async #calibrate() {
    const report = this.#report
    for (let i = 0; i < CALIBRATION_LOADS; i++) {
      const baseline = await this.#load({ calibrate: true })
      if (i === 0)
        Object.assign(
          baseline,
          await screenshotRun(this.#screenshot, this.#setup.page, 'baseline'),
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
    this.#trustedFingerprint = first.ui.fingerprint
    report.readiness.calibrationComplete = true
    const callsPerLoad = report.baselines.map(
      (b) => b.snapshot.channels[this.#setup.read].realCalls,
    )
    report.readiness.callsPerLoad = callsPerLoad
    report.readiness.callsGap = callsGap(
      callsPerLoad,
      this.#setup.laterCallFault !== undefined,
    )
  }

  /** The configured experiments, then one per later call when the transport can fail those. */
  #planned(): DiscoveryExperiment<Fault>[] {
    const fault = this.#setup.laterCallFault
    const later =
      fault === undefined
        ? []
        : laterCalls(this.#report.readiness.callsPerLoad!).map((call) => ({
            fault,
            times: 1,
            call,
          }))
    return [...this.#setup.experiments, ...later]
  }

  // A healthy control before every faulted load also clears the previous state.
  async #healthyControl() {
    const report = this.#report
    const healthy = await this.#load({
      expectedFingerprint: this.#trustedFingerprint,
    })
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

  async #experiment(planned: DiscoveryExperiment<Fault>) {
    const id = findingId(planned)
    const runs: DiscoveryRun<Fault, Snapshot>[] = []
    for (let i = 0; i < this.#timing.repeats; i++) {
      const healthy = await this.#healthyControl()
      const result = await this.#load({ experiment: planned })
      const run = {
        ...faultedRun(planned, healthy, result),
        ...(await screenshotRun(
          this.#screenshot,
          this.#setup.page,
          `${id}-run${i + 1}`,
        )),
      }
      runs.push(run)
      this.#report.results.push(run)
    }
    this.#report.findings.push(this.#finding(id, planned, runs))
  }

  #finding(
    id: string,
    planned: DiscoveryExperiment<Fault>,
    runs: DiscoveryRun<Fault, Snapshot>[],
  ) {
    const consistent = runs.every(
      (r) => r.assessment.classification === runs[0].assessment.classification,
    )
    const assessment = consistent
      ? runs[0].assessment
      : { classification: 'UNSTABLE', kind: 'inconclusive', confidence: 'low' }
    return {
      id,
      ...planned,
      ...assessment,
      confirmations: runs.length,
      repeatConfirmed: consistent && runs.length >= 3,
      observationMs: this.#timing.observationMs,
      advice: advice(assessment.classification),
      verification: this.#setup.verification,
    }
  }

  /** One last healthy load, so the app is left as it was found. */
  async #reset() {
    const report = this.#report
    const trusted = this.#trustedFingerprint
    try {
      const cleanup = await this.#load({ expectedFingerprint: trusted })
      report.cleanup = cleanup
      report.finalReset =
        trusted !== undefined &&
        cleanup.ready &&
        !cleanup.newErrors &&
        cleanup.ui.fingerprint === trusted
          ? 'healthy'
          : 'not-verified'
    } catch (error) {
      report.cleanupError = (error as Error).message
    }
  }

  async #release() {
    const report = this.#report
    try {
      await this.#setup.session.stop()
    } catch (error) {
      report.finalReset = 'not-verified'
      report.cleanupError ??= (error as Error).message
    }
    try {
      // The window state is recorded as soon as visibility is prepared.
      if (this.#visibility)
        report.window!.restoration = await this.#visibility.revert()
    } catch (error) {
      report.windowRestoreError = (error as Error).message
    }
    this.#setup.page.off('pageerror', this.#countError)
  }

  #conclude() {
    const report = this.#report
    report.ok =
      !report.error &&
      !report.cleanupError &&
      !report.windowRestoreError &&
      report.finalReset === 'healthy' &&
      report.findings.every((f) => f.kind === 'observation')
    retainPartialFindings(report, this.#timing.repeats)
  }
}

/** A faulted load, compared with the healthy control before it. */
function faultedRun<Fault extends string, Snapshot extends ReadSnapshot>(
  planned: DiscoveryExperiment<Fault>,
  healthy: DiscoveryPhase<Fault, Snapshot>,
  result: DiscoveryPhase<Fault, Snapshot>,
): DiscoveryRun<Fault, Snapshot> {
  const assessment = classifyObservation({
    baseline: healthy.ui,
    final: result.ui,
    injected: result.snapshot.injected,
    expected: planned.times,
    recovered: result.ready,
    newErrors: result.newErrors,
  })
  return {
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
  }
}
