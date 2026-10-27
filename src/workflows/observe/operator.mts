import type { ObservationHooks } from './capture.mjs'
import type { ObservationOperator } from './report.mjs'

const OPERATOR_STOP_MS = 5000

/** Runs the optional operator (for example --steps) beside the capture, with its interval markers. */
export class OperatorRun {
  readonly #abort = new AbortController()
  readonly #markerRequests: { resolve?: (index: number | null) => void }[] = []
  #run?: Promise<ObservationOperator>

  start(operator: ObservationHooks['operator'], elapsed: () => number) {
    if (!operator) return
    const abort = this.#abort
    const mark = () =>
      new Promise<number | null>((resolve) =>
        this.#markerRequests.push({ resolve }),
      )
    this.#run = Promise.resolve()
      .then(() => operator({ mark, signal: abort.signal, elapsed }))
      .then(
        (steps): ObservationOperator => ({
          status: 'complete',
          ...(Array.isArray(steps) ? { steps } : {}),
        }),
        (error): ObservationOperator => ({
          status: abort.signal.aborted ? 'stopped' : 'failed',
          error: error.message,
          ...(Array.isArray(error.results) ? { steps: error.results } : {}),
        }),
      )
  }

  /** The next interval to open: one the operator asked for, or one `takeMarker` reports. */
  nextMarker(takeMarker: ObservationHooks['takeMarker']) {
    if (this.#markerRequests.length) return this.#markerRequests.shift()
    return takeMarker?.() ? {} : null
  }

  /** Stops the operator and returns its outcome, or undefined when there was none. */
  async finish(): Promise<ObservationOperator | undefined> {
    this.#abort.abort()
    for (const pending of this.#markerRequests) pending.resolve?.(null)
    if (!this.#run) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    // An operator that ignores the stop signal must not hold cleanup hostage.
    const outcome = await Promise.race([
      this.#run,
      new Promise<ObservationOperator>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: 'stopped',
              error: `Operator did not stop within ${OPERATOR_STOP_MS} ms`,
            }),
          OPERATOR_STOP_MS,
        )
      }),
    ])
    clearTimeout(timer)
    return outcome
  }
}
