import type { Page } from 'playwright'
import { compareRegions } from '../../core/screen.mjs'
import {
  classifyRefresh,
  refreshFindings,
  secondTriggerResult,
} from './classify.mjs'
import { refreshConfig, type RefreshConfig } from './config.mjs'
import { anyErrors, RefreshProbe, settled } from './probe.mjs'
import type {
  Observed,
  RefreshAdapter,
  RefreshReport,
  RefreshRun,
} from './types.mjs'

const CALIBRATION_LOADS = 3

// Both transports supply begin/snapshot/disarm/stop. No reload occurs between
// the faulted refresh and its spontaneous/optional second-trigger observations.
export async function runRefresh(
  page: Page,
  input: object,
  adapter: RefreshAdapter,
  { signal }: { signal?: AbortSignal } = {},
): Promise<RefreshReport> {
  const config = refreshConfig(input)
  return new RefreshExperiment(page, config, adapter, signal).run()
}

function initialReport(config: RefreshConfig): RefreshReport {
  return {
    schemaVersion: 1,
    mode: 'refresh experiment',
    trigger: {
      ...config.trigger,
      synthesized: true,
      changesNetworkState: false,
    },
    readiness: {
      strategy: 'bounded-end-state-calibration',
      calibrationRuns: CALIBRATION_LOADS,
      calibrationWindowMs: config.baselineTimeoutMs,
      settleMs: config.settleMs,
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
}

/** Calibrates, then runs a healthy and a faulted trigger per repeat, and cleans up. */
class RefreshExperiment {
  readonly #config: RefreshConfig
  readonly #adapter: RefreshAdapter
  readonly #report: RefreshReport
  readonly #probe: RefreshProbe

  constructor(
    page: Page,
    config: RefreshConfig,
    adapter: RefreshAdapter,
    signal: AbortSignal | undefined,
  ) {
    this.#config = config
    this.#adapter = adapter
    this.#report = initialReport(config)
    this.#probe = new RefreshProbe(page, config, adapter, {
      signal,
      report: this.#report,
    })
  }

  async run(): Promise<RefreshReport> {
    const report = this.#report
    this.#probe.listen()
    try {
      const base = await this.#calibrate()
      for (let i = 0; i < this.#config.repeats; i++)
        if (!(await this.#runOnce(i, base))) break
    } catch (error) {
      report.error = (error as Error).message
    } finally {
      await this.#cleanup()
      this.#probe.stopListening()
    }
    report.findings = refreshFindings(report.results, this.#config)
    report.ok =
      !report.error &&
      !report.cleanupError &&
      report.finalReset === 'healthy' &&
      report.faultReset === 'healthy' &&
      report.findings.every((f) => f.kind === 'observation')
    return report
  }

  async #calibrate(): Promise<Observed> {
    const probe = this.#probe
    const baselines = this.#report.baselines
    for (let i = 0; i < CALIBRATION_LOADS; i++) {
      probe.checkAbort()
      const b = await probe.load(undefined, false, true)
      baselines.push(b)
      if (!b.ready || probe.errors) throw Error('BASELINE_UNSTABLE')
    }
    const [first] = baselines
    if (!baselines.every((b) => b.ui.fingerprint === first.ui.fingerprint))
      throw Error('BASELINE_UNSTABLE')
    probe.baseline = first
    return first
  }

  /** One run: a healthy trigger, then a faulted one. False when the trigger read nothing. */
  async #runOnce(i: number, base: Observed): Promise<boolean> {
    const c = this.#config
    const row: RefreshRun = {
      run: i + 1,
      requested: c.times,
      observationMs: c.observationMs,
      attribution: { kind: 'temporal-association', causalProof: false },
      stage: 'control',
    }
    this.#report.results.push(row)
    const initialErrors = this.#probe.errors
    if (!(await this.#controlPhase(row, base))) return false
    await this.#faultPhase(row, base, initialErrors)
    if (c.secondTrigger && row.kind !== 'inconclusive')
      await this.#secondTrigger(row, base)
    row.stage = 'completed'
    row.summary = `After the synthetic ${c.trigger.name} event, ${row.injected}/${c.times} faults were consumed; ${row.code}. ${row.noSubsequentReadObserved ? 'No subsequent target read was observed' : 'Subsequent target reads were observed'} within ${c.observationMs} ms.`
    return true
  }

  /** The trigger without faults: it must read the target and leave the screen as it was. */
  async #controlPhase(row: RefreshRun, base: Observed): Promise<boolean> {
    const probe = this.#probe
    const target = probe.target
    const healthyRun = await probe.load(base.ui.fingerprint)
    row.healthy = healthyRun
    if (!healthyRun.ready) throw Error('CONTROL_UNSTABLE')
    row.idle = await probe.quiet()
    await this.#adapter.begin()
    row.controlTrigger = await probe.fire()
    const control = await probe.observe({
      ms: this.#config.baselineTimeoutMs,
      predicate: (v, stable) =>
        stable &&
        !v.ui.loading &&
        settled(v.snapshot) &&
        v.snapshot.channels[target].successes > 0 &&
        v.ui.fingerprint === base.ui.fingerprint,
    })
    row.control = control
    if (!control.snapshot.channels[target].calls) {
      row.code = 'TRIGGER_NO_READ'
      row.kind = 'inconclusive'
      return false
    }
    if (!control.ready || anyErrors(control.snapshot))
      throw Error('TRIGGER_CONTROL_UNSTABLE')
    row.controlReads = Object.entries(control.snapshot.channels)
      .filter(([, r]) => r.calls)
      .map(([read, r]) => ({ read, calls: r.calls }))
    return true
  }

  /** The trigger with the read failing; only what happens on its own is observed. */
  async #faultPhase(row: RefreshRun, base: Observed, initialErrors: number) {
    const c = this.#config
    const probe = this.#probe
    const preFault = await probe.load(base.ui.fingerprint)
    row.preFault = preFault
    if (!preFault.ready) throw Error('CONTROL_UNSTABLE')
    row.preFaultIdle = await probe.quiet()
    await this.#adapter.begin({
      fault: c.fault,
      times: c.times,
      ttlMs: c.observationMs + 5000,
    })
    row.stage = 'fault'
    row.trigger = await probe.fire()
    // Never issue another trigger in this phase.
    const spontaneous = await probe.observe({ ms: c.observationMs })
    row.spontaneous = spontaneous
    await this.#adapter.disarm()
    this.#report.faultReset = 'healthy'
    const s = spontaneous.snapshot
    row.injected = s.injected
    const observation = compareRegions(preFault.ui, spontaneous.ui)
    row.observation = observation
    row.subsequentRealReads = s.channels[probe.target].realCalls
    row.noSubsequentReadObserved = row.subsequentRealReads === 0
    Object.assign(
      row,
      classifyRefresh({
        spontaneous,
        observation,
        baselineFingerprint: base.ui.fingerprint,
        times: c.times,
        pageErrors: probe.errors > initialErrors,
      }),
    )
    row.freshReadSucceeded = s.successfulAfterFault > 0
  }

  // Its result never changes the spontaneous-phase classification.
  async #secondTrigger(row: RefreshRun, base: Observed) {
    const probe = this.#probe
    if (!settled(row.spontaneous!.snapshot))
      throw Error('PENDING_READS_BEFORE_SECOND_TRIGGER')
    await this.#adapter.begin()
    row.stage = 'second-trigger'
    row.secondTrigger = await probe.fire()
    const after = await probe.observe({ ms: this.#config.observationMs })
    row.afterSecondTrigger = after
    row.secondTriggerResult = secondTriggerResult(
      after,
      probe.target,
      base.ui.fingerprint,
    )
  }

  /** Removes any fault, reloads once more to leave the app healthy, and stops observing. */
  async #cleanup() {
    const report = this.#report
    const baseline = this.#probe.baseline
    let safe = false
    try {
      await this.#adapter.disarm()
      report.faultReset = 'healthy'
      safe = true
    } catch (error) {
      report.cleanupError = (error as Error).message
    }
    if (safe && baseline)
      try {
        report.cleanup = await this.#probe.load(baseline.ui.fingerprint, true)
        report.finalReset = report.cleanup.ready ? 'healthy' : 'not-verified'
      } catch (error) {
        report.cleanupError = (error as Error).message
      }
    try {
      await this.#adapter.stop()
    } catch (error) {
      report.cleanupError = (error as Error).message
      report.faultReset = 'not-verified'
    }
  }
}
