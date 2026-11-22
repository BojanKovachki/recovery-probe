import { performance } from 'node:perf_hooks'

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
