import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { RegionSummary } from '../../core/screen.mjs'
import {
  matchesHealthyControl,
  type DiscoveryExperiment,
} from './experiment.mjs'
import type {
  DiscoveryEvent,
  DiscoveryPhase,
  DiscoveryResult,
  DiscoverySetup,
  DiscoveryTiming,
  ReadSnapshot,
} from './types.mjs'

const POLL_MS = 100
const MAX_EVENTS = 100

/** What a load needs from the discovery that runs it. */
export interface LoadContext<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  setup: DiscoverySetup<Fault, Snapshot>
  timing: DiscoveryTiming
  report: DiscoveryResult<Fault, Snapshot>
  /** Reads the region, failing when the window or network blocks the experiment. */
  screen(): Promise<RegionSummary>
  /** Uncaught page errors so far. */
  errors(): number
  trustedFingerprint(): string | undefined
}

export interface LoadPlan<Fault extends string> {
  experiment?: DiscoveryExperiment<Fault>
  expectedFingerprint?: string
  /** Calibration loads run their full time instead of stopping when ready. */
  calibrate?: boolean
}

/** One reload, healthy or with the experiment's faults armed, watched until ready or out of time. */
export function load<Fault extends string, Snapshot extends ReadSnapshot>(
  context: LoadContext<Fault, Snapshot>,
  plan: LoadPlan<Fault> = {},
): Promise<DiscoveryPhase<Fault, Snapshot>> {
  return new Load(context, plan).run()
}

class Load<Fault extends string, Snapshot extends ReadSnapshot> {
  readonly #context: LoadContext<Fault, Snapshot>
  readonly #plan: LoadPlan<Fault>
  readonly #fault?: Fault
  readonly #times: number
  readonly #call?: number
  readonly #started = performance.now()
  readonly #initialErrors: number
  readonly #timeline: DiscoveryEvent<Snapshot>[] = []
  #stableSince = this.#started
  #previous?: string
  #previousEvent?: string
  #snapshot?: Snapshot
  #summary?: RegionSummary
  #firstInjection?: number

  constructor(context: LoadContext<Fault, Snapshot>, plan: LoadPlan<Fault>) {
    this.#context = context
    this.#plan = plan
    const { fault, times = 1, call } = plan.experiment ?? {}
    this.#fault = fault
    this.#times = times
    this.#call = call
    this.#initialErrors = context.errors()
  }

  async run(): Promise<DiscoveryPhase<Fault, Snapshot>> {
    const { setup, timing, report } = this.#context
    const fault = this.#fault
    try {
      await setup.session.begin(
        fault
          ? {
              fault,
              times: this.#times,
              ...(this.#call ? { skip: this.#call - 1 } : {}),
            }
          : {},
      )
      await setup.page.reload({
        waitUntil: 'domcontentloaded',
        timeout: timing.baselineTimeoutMs,
      })
      while (true) {
        const phase = await this.#poll()
        if (phase) return phase
        await sleep(POLL_MS)
      }
    } catch (error) {
      report.stoppedObservation ??= {
        reason: (error as Error).message,
        fault: fault ?? 'healthy',
        times: this.#times,
        snapshot: this.#snapshot,
        ui: this.#summary,
        timeline: this.#timeline,
      }
      throw error
    } finally {
      await setup.session.stop()
    }
  }

  /** One look at the counters and the screen; the phase once the load is done. */
  async #poll(): Promise<DiscoveryPhase<Fault, Snapshot> | undefined> {
    const { setup, timing } = this.#context
    const current = await setup.session.snapshot()
    this.#snapshot = current
    if (current.injectionError) throw new Error('INJECTION_ERROR')
    if (current.injected && this.#firstInjection === undefined)
      this.#firstInjection = performance.now()
    const ui = await this.#context.screen()
    this.#summary = ui
    this.#record(current, ui)
    this.#requireHealthyReads(current)
    const ready = this.#ready(current, ui)
    const elapsed = performance.now() - (this.#firstInjection ?? this.#started)
    const limit =
      this.#firstInjection === undefined
        ? timing.baselineTimeoutMs
        : timing.observationMs
    if ((!this.#plan.calibrate && ready) || elapsed >= limit)
      return this.#phase(current, ui, ready)
  }

  #record(current: Snapshot, ui: RegionSummary) {
    const signature = JSON.stringify(ui)
    if (signature !== this.#previous) {
      this.#previous = signature
      this.#stableSince = performance.now()
    }
    const event = {
      elapsedMs: Math.round(performance.now() - this.#started),
      injected: current.injected,
      channels: current.channels,
      ui,
      uncaughtErrors: this.#context.errors() - this.#initialErrors,
    }
    // Bound reports without capturing payloads, filenames, error messages or stacks.
    const eventSignature = JSON.stringify({ ...event, elapsedMs: 0 })
    if (
      this.#timeline.length < MAX_EVENTS &&
      eventSignature !== this.#previousEvent
    ) {
      this.#timeline.push(event)
      this.#previousEvent = eventSignature
    }
  }

  #requireHealthyReads(current: Snapshot) {
    const { read, dependencies, readFailed } = this.#context.setup
    if (dependencies.some((d) => current.channels[d].errors))
      throw new Error('DEPENDENCY_FAILED')
    if (current.channels[read].errors) throw new Error(readFailed)
  }

  /**
   * Ready means the screen matches the healthy control and has been stable, every read
   * it needs has succeeded, and a faulted load injected all its faults then read again.
   */
  #ready(current: Snapshot, ui: RegionSummary) {
    const { setup, timing } = this.#context
    const target = current.channels[setup.read]
    const settled =
      target.pending === 0 &&
      setup.dependencies.every((d) => {
        const row = current.channels[d]
        return row.successes > 0 && row.pending === 0
      })
    return (
      matchesHealthyControl(ui, this.#plan.expectedFingerprint) &&
      settled &&
      !ui.loading &&
      performance.now() - this.#stableSince >= timing.settleMs &&
      target.successes > 0 &&
      (!this.#fault || this.#recoveredFrom(current, ui))
    )
  }

  #recoveredFrom(current: Snapshot, ui: RegionSummary) {
    return (
      current.injected === this.#times &&
      current.successfulAfterFault > 0 &&
      ui.fingerprint === this.#context.trustedFingerprint()
    )
  }

  #phase(
    current: Snapshot,
    ui: RegionSummary,
    ready: boolean,
  ): DiscoveryPhase<Fault, Snapshot> {
    const { setup, timing } = this.#context
    const fault = this.#fault
    const detectedAt = Date.now()
    const recovered = Boolean(fault) && ready
    return {
      elapsedMs: Math.round(performance.now() - this.#started),
      fault: fault ?? 'healthy',
      times: fault ? this.#times : 0,
      ...(this.#call ? { call: this.#call } : {}),
      ready,
      ui,
      snapshot: current,
      timeline: this.#timeline,
      newErrors: this.#context.errors() - this.#initialErrors,
      recoveryDetectedAt: recovered ? detectedAt : null,
      recoveryMs: recovered
        ? detectedAt - (current.injectedAt ?? detectedAt)
        : null,
      timingNote: `Sampled recovery with ${timing.settleMs}ms UI stability; bounded observation starts at first observed injection.`,
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
}
