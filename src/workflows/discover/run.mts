import { readRegion } from '../../core/region-read.mjs'
import {
  compareRegions,
  summarizeRegion,
  type RegionSummary,
} from '../../core/screen.mjs'
import { pageAddress } from '../../core/urls.mjs'
import {
  prepareVisibility,
  windowVisibility,
  type PreparedVisibility,
} from '../../targets/visibility.mjs'
import {
  CALIBRATION_LOADS,
  calibrationWorstCaseMs,
  experimentWorstCaseMs,
} from './budget.mjs'
import { RunControl, type DiscoveryOptions } from './control.mjs'
import {
  callsGap,
  findingId,
  planExperiments,
  retainPartialFindings,
  type DiscoveryExperiment,
} from './experiment.mjs'
import { load, type LoadContext, type LoadPlan } from './load.mjs'
import { faultedRun, findingOf } from './runs.mjs'
import { checkScreenUsesRead } from './screen-check.mjs'
import { screenshotRun } from './screenshots.mjs'
import type {
  DiscoveryResult,
  DiscoveryRun,
  DiscoverySetup,
  DiscoveryTiming,
  ReadSnapshot,
} from './types.mjs'

/**
 * Calibrates three healthy loads, checks that failing the selected read shows on
 * the screen, then fails it in each planned way, with a healthy control before
 * every faulted load, and fills `report`. With `timing.maxDurationMs`, it starts no
 * step that can't finish in time, stops any that runs over, and keeps time for cleanup.
 */
export async function runDiscovery<
  Fault extends string,
  Snapshot extends ReadSnapshot,
>(
  setup: DiscoverySetup<Fault, Snapshot>,
  timing: DiscoveryTiming,
  report: DiscoveryResult<Fault, Snapshot>,
  options: DiscoveryOptions<Fault, Snapshot> = {},
): Promise<void> {
  await new Discovery(setup, timing, report, options).run()
}

class Discovery<Fault extends string, Snapshot extends ReadSnapshot> {
  readonly #setup: DiscoverySetup<Fault, Snapshot>
  readonly #timing: DiscoveryTiming
  readonly #report: DiscoveryResult<Fault, Snapshot>
  readonly #options: DiscoveryOptions<Fault, Snapshot>
  readonly #initialUrl: string
  readonly #loads: LoadContext<Fault, Snapshot>
  readonly #control: RunControl<Fault, Snapshot>
  #errors = 0
  #trustedFingerprint?: string
  #visibility?: PreparedVisibility
  #countError = () => this.#errors++

  constructor(
    setup: DiscoverySetup<Fault, Snapshot>,
    timing: DiscoveryTiming,
    report: DiscoveryResult<Fault, Snapshot>,
    options: DiscoveryOptions<Fault, Snapshot>,
  ) {
    this.#setup = setup
    this.#timing = timing
    this.#report = report
    this.#options = options
    this.#initialUrl = setup.page.url()
    this.#control = new RunControl(timing, report, options)
    this.#loads = {
      setup,
      timing,
      report,
      screen: () => this.#screen(),
      errors: () => this.#errors,
      trustedFingerprint: () => this.#trustedFingerprint,
      stopReason: () => this.#control.stopReason(),
      timeLeftMs: () => this.#control.timeLeftMs(),
    }
  }

  async run() {
    const { page, control } = this.#setup
    page.on('pageerror', this.#countError)
    this.#report.page = pageAddress(this.#initialUrl)
    await this.#control.start(this.#setup)
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
    await this.#control.progress('finished')
  }

  async #load(plan: LoadPlan<Fault> = {}) {
    const phase = await load(this.#loads, plan)
    await this.#control.loaded(Boolean(plan.experiment))
    return phase
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
      this.#control.beginWithin(calibrationWorstCaseMs(this.#timing))
      await this.#calibrate()
      await this.#control.progress('checking-screen')
      await checkScreenUsesRead(this.#loads, this.#initialUrl)
      await this.#control.loaded(true)
      const { experiments, laterCallFault } = this.#setup
      const planned = planExperiments(
        experiments,
        laterCallFault,
        this.#report.readiness.callsPerLoad!,
      )
      this.#control.planned(planned.map(findingId))
      await this.#control.progress('experimenting')
      for (const experiment of planned) {
        this.#control.beginWithin(experimentWorstCaseMs(this.#timing))
        await this.#experiment(experiment)
      }
    } catch (error) {
      this.#report.error = (error as Error).message
    } finally {
      await this.#reset()
    }
  }

  async #calibrate() {
    const report = this.#report
    await this.#control.progress('calibrating')
    for (let i = 0; i < CALIBRATION_LOADS; i++) {
      const baseline = await this.#load({ calibrate: true })
      if (i === 0)
        Object.assign(
          baseline,
          await screenshotRun(
            this.#options.screenshot,
            this.#setup.page,
            'baseline',
          ),
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
          this.#options.screenshot,
          this.#setup.page,
          `${id}-run${i + 1}`,
        )),
      }
      runs.push(run)
      this.#report.results.push(run)
    }
    this.#report.findings.push(
      findingOf(id, planned, runs, {
        observationMs: this.#timing.observationMs,
        verification: this.#setup.verification,
      }),
    )
  }

  /**
   * One last healthy load, so the app is left as it was found. It runs in the time kept
   * for it; one that can't start or finish in time is reported, never taken as healthy.
   */
  async #reset() {
    const report = this.#report
    const trusted = this.#trustedFingerprint
    this.#control.cleaningUp()
    await this.#control.progress('cleaning-up')
    if (!this.#control.timeLeftForCleanup()) {
      report.cleanupError =
        'CLEANUP_SKIPPED: no time was left in maxDurationMs for the final reload'
      return
    }
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
      const message = (error as Error).message
      report.cleanupError =
        message === 'BUDGET_EXHAUSTED'
          ? 'CLEANUP_TIMEOUT: the final reload did not finish within maxDurationMs'
          : message
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
    this.#control.conclude()
  }
}
