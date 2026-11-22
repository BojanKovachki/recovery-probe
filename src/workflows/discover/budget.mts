import { performance } from 'node:perf_hooks'
import { ensure, isIntegerIn } from '../../core/validate.mjs'
import { MAX_TARGETED_CALL } from './experiment.mjs'
import type { DiscoveryTiming } from './types.mjs'

/** Healthy loads that calibrate the screen before any fault. */
export const CALIBRATION_LOADS = 3

const [SHORTEST_LIMIT_MS, LONGEST_LIMIT_MS] = [10000, 86400000]

/** Throws unless a configured `maxDurationMs` is absent or 10 seconds to 24 hours. */
export function ensureMaxDuration(value: unknown): void {
  ensure(
    value === undefined ||
      isIntegerIn(value, SHORTEST_LIMIT_MS, LONGEST_LIMIT_MS),
    `maxDurationMs must be ${SHORTEST_LIMIT_MS}–${LONGEST_LIMIT_MS}`,
  )
}

// What a load spends outside its own window: arming and clearing faults, reading the
// counters and the screen. An allowance for the estimate; the deadline is what stops a run.
const LOAD_OVERHEAD_MS = 2000
// Removing the faults and putting the window back after the last load.
const RELEASE_MS = 5000

type Timing = Pick<
  DiscoveryTiming,
  'baselineTimeoutMs' | 'observationMs' | 'repeats'
>

/**
 * The longest one load can take. A healthy load is watched for at most
 * `baselineTimeoutMs`, reload included; a faulted one for `observationMs` more after
 * its first fault, which can come as late as the end of that window.
 */
export function loadWorstCaseMs(timing: Timing, faulted: boolean): number {
  return (
    timing.baselineTimeoutMs +
    (faulted ? timing.observationMs : 0) +
    LOAD_OVERHEAD_MS
  )
}

/** One experiment: a healthy control and a faulted load per repeat. */
export function experimentWorstCaseMs(timing: Timing): number {
  return (
    timing.repeats *
    (loadWorstCaseMs(timing, false) + loadWorstCaseMs(timing, true))
  )
}

/** Calibration, then the check that failing the read shows on the screen. */
export function calibrationWorstCaseMs(timing: Timing): number {
  return (
    CALIBRATION_LOADS * loadWorstCaseMs(timing, false) +
    loadWorstCaseMs(timing, true)
  )
}

/** Time kept back for cleanup: the final healthy reload, then removing faults and restoring the window. */
export function cleanupReserveMs(timing: Timing): number {
  return loadWorstCaseMs(timing, false) + RELEASE_MS
}

export interface DiscoveryEstimate {
  /** Every reload the run makes: calibration, the screen check, the experiments and cleanup. */
  plannedLoads: number
  /** The longest the run can take, from its configured timeouts. A deadline still applies. */
  worstCaseMs: number
  experiments: number
  /** True once calibration showed which later calls of a load are failed one by one. */
  exact: boolean
}

/**
 * The worst case of a run with `experiments` experiments. Before calibration, the
 * later-call experiments are not known yet, so the estimate counts the most there can be.
 */
export function estimateDiscovery(
  timing: Timing,
  experiments: number,
  exact: boolean,
): DiscoveryEstimate {
  return {
    plannedLoads: CALIBRATION_LOADS + 1 + experiments * timing.repeats * 2 + 1,
    worstCaseMs:
      calibrationWorstCaseMs(timing) +
      experiments * experimentWorstCaseMs(timing) +
      cleanupReserveMs(timing),
    experiments,
    exact,
  }
}

/** The most experiments a run can plan before calibration counts the reads of a load. */
export const mostExperiments = (configured: number, laterCalls: boolean) =>
  configured + (laterCalls ? MAX_TARGETED_CALL - 1 : 0) + 1

/**
 * A run's time limit. Work stops early enough to leave `reserveMs` for cleanup, and
 * cleanup has until the end of the limit.
 */
export class RunBudget {
  readonly maxDurationMs: number
  readonly reserveMs: number
  readonly #started: number
  readonly #now: () => number

  constructor(
    maxDurationMs: number,
    reserveMs: number,
    started?: number,
    now: () => number = () => performance.now(),
  ) {
    this.maxDurationMs = maxDurationMs
    this.reserveMs = reserveMs
    this.#now = now
    this.#started = started ?? now()
  }

  elapsedMs(): number {
    return this.#now() - this.#started
  }

  /** Time left for experiments, before the cleanup reserve. */
  workLeftMs(): number {
    return this.maxDurationMs - this.reserveMs - this.elapsedMs()
  }

  /** Time left before the limit ends, cleanup included. */
  totalLeftMs(): number {
    return this.maxDurationMs - this.elapsedMs()
  }

  /** Whether work whose worst case is `worstCaseMs` can finish before the cleanup reserve. */
  fits(worstCaseMs: number): boolean {
    return worstCaseMs <= this.workLeftMs()
  }
}
