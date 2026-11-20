import { performance } from 'node:perf_hooks'
import {
  cleanupReserveMs,
  estimateDiscovery,
  loadWorstCaseMs,
  mostExperiments,
  RunBudget,
} from './budget.mjs'
import type { DiscoveryScreenshot } from './screenshots.mjs'
import type {
  DiscoveryProgress,
  DiscoveryResult,
  DiscoverySetup,
  DiscoveryStop,
  DiscoveryTiming,
  ReadSnapshot,
} from './types.mjs'

const STOPS: readonly string[] = [
  'BUDGET_EXHAUSTED',
  'INTERRUPTED',
] satisfies DiscoveryStop[]

export interface DiscoveryOptions<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  screenshot?: DiscoveryScreenshot
  /** Stops the run at the next load or poll; cleanup still runs and the report is filled. */
  signal?: AbortSignal
  /** Called after every load, and when the run starts and finishes. */
  onProgress?: (
    progress: DiscoveryProgress,
    report: DiscoveryResult<Fault, Snapshot>,
  ) => void | Promise<void>
  /** When the run's time limit started, from performance.now(); the call to runDiscovery by default. */
  startedAt?: number
}

/**
 * A run's time limit, why it must stop, and its progress: what discovery needs to stay
 * bounded and to tell whoever waits on it how far it got.
 */
export class RunControl<Fault extends string, Snapshot extends ReadSnapshot> {
  readonly #timing: DiscoveryTiming
  readonly #report: DiscoveryResult<Fault, Snapshot>
  readonly #options: DiscoveryOptions<Fault, Snapshot>
  readonly #started: number
  readonly #budget?: RunBudget
  #phase: DiscoveryProgress['phase'] = 'starting'
  #cleaningUp = false
  #completedLoads = 0
  // The worst case of the loads done so far, to say how long the rest can take.
  #spentWorstCaseMs = 0
  #planned: string[] = []

  constructor(
    timing: DiscoveryTiming,
    report: DiscoveryResult<Fault, Snapshot>,
    options: DiscoveryOptions<Fault, Snapshot>,
  ) {
    this.#timing = timing
    this.#report = report
    this.#options = options
    this.#started = options.startedAt ?? performance.now()
    if (timing.maxDurationMs !== undefined)
      this.#budget = new RunBudget(
        timing.maxDurationMs,
        cleanupReserveMs(timing),
        this.#started,
      )
  }

  /** Records the first estimate and the time limit, and reports that the run started. */
  async start(setup: DiscoverySetup<Fault, Snapshot>) {
    const { experiments, laterCallFault } = setup
    this.#report.estimate = estimateDiscovery(
      this.#timing,
      mostExperiments(experiments.length, laterCallFault !== undefined),
      false,
    )
    if (this.#budget)
      this.#report.budget = {
        maxDurationMs: this.#budget.maxDurationMs,
        cleanupReserveMs: this.#budget.reserveMs,
      }
    await this.progress('starting')
  }

  /** Calibration showed which experiments run: the estimate becomes exact. */
  planned(ids: string[]) {
    this.#planned = ids
    this.#report.estimate = estimateDiscovery(this.#timing, ids.length, true)
  }

  /** Cleanup ignores an interruption, but not the end of the time limit. */
  cleaningUp() {
    this.#cleaningUp = true
  }

  /** Why the run must stop now. */
  stopReason(): DiscoveryStop | undefined {
    if (this.#cleaningUp)
      return this.#budget && this.#budget.totalLeftMs() <= 0
        ? 'BUDGET_EXHAUSTED'
        : undefined
    if (this.#options.signal?.aborted) return 'INTERRUPTED'
    if (this.#budget && this.#budget.workLeftMs() <= 0)
      return 'BUDGET_EXHAUSTED'
  }

  /** Time left before the deadline that applies now; none without a time limit. */
  timeLeftMs(): number | undefined {
    return this.#cleaningUp
      ? this.#budget?.totalLeftMs()
      : this.#budget?.workLeftMs()
  }

  /** Whether any time is left for cleanup; always, without a time limit. */
  timeLeftForCleanup(): boolean {
    return !this.#budget || this.#budget.totalLeftMs() > 0
  }

  /** Throws unless a step whose worst case is `worstCaseMs` can start and finish before the cleanup reserve. */
  beginWithin(worstCaseMs: number) {
    const reason =
      this.stopReason() ??
      (this.#budget && !this.#budget.fits(worstCaseMs)
        ? 'BUDGET_EXHAUSTED'
        : undefined)
    if (reason) throw new Error(reason)
  }

  async loaded(faulted: boolean) {
    this.#completedLoads++
    this.#spentWorstCaseMs += loadWorstCaseMs(this.#timing, faulted)
    await this.progress()
  }

  // Progress is for whoever waits on the run; failing to save it never stops the run.
  async progress(phase = this.#phase) {
    this.#phase = phase
    const { onProgress } = this.#options
    if (!onProgress) return
    const report = this.#report
    const estimate = report.estimate!
    const progress: DiscoveryProgress = {
      phase,
      completedLoads: this.#completedLoads,
      plannedLoads: estimate.plannedLoads,
      elapsedMs: Math.round(performance.now() - this.#started),
      worstCaseRemainingMs:
        phase === 'finished'
          ? 0
          : Math.max(0, estimate.worstCaseMs - this.#spentWorstCaseMs),
      experiments: {
        planned: this.#planned,
        done: report.findings.filter((f) => !f.partial).map((f) => f.id),
      },
      ...(this.#budget
        ? {
            budget: {
              maxDurationMs: this.#budget.maxDurationMs,
              remainingMs: Math.max(0, Math.round(this.#budget.totalLeftMs())),
            },
          }
        : {}),
      ...(report.stoppedReason ? { stoppedReason: report.stoppedReason } : {}),
    }
    try {
      await onProgress(progress, report)
    } catch (error) {
      report.progressError ??= (error as Error).message
    }
  }

  /** Says why a stopped run stopped, which planned experiments it never started, and the time it used. */
  conclude() {
    const report = this.#report
    if (report.error && STOPS.includes(report.error)) {
      report.stoppedReason = report.error as DiscoveryStop
      report.notRun = this.#planned.filter(
        (id) => !report.findings.some((finding) => finding.id === id),
      )
    }
    if (report.budget && this.#budget)
      report.budget.usedMs = Math.round(this.#budget.elapsedMs())
  }
}
