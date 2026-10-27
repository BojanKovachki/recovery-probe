import type { Request, Response } from 'playwright'

/** One read of the selected endpoint: when it started and finished, and how. */
export interface ReadRecord {
  startedAt: number
  completedAt: number | null
  status: number | null
  outcome: 'pending' | 'success' | 'error' | 'failed'
  /** Request start to the last response byte, as the browser timed it. */
  networkMs: number | null
}

export interface ReadLogSnapshot {
  reads: ReadRecord[]
  truncated: boolean
}

const MAX_READS = 500

/** Keeps a record per read, so a slow read can be told apart from a slow screen. */
export class ReadLog {
  readonly #reads: ReadRecord[] = []
  #truncated = false

  /** Starts a record, or returns undefined once the log is full. */
  start(): ReadRecord | undefined {
    if (this.#reads.length >= MAX_READS) {
      this.#truncated = true
      return undefined
    }
    const record: ReadRecord = {
      startedAt: Date.now(),
      completedAt: null,
      status: null,
      outcome: 'pending',
      networkMs: null,
    }
    this.#reads.push(record)
    return record
  }

  finish(record: ReadRecord, request: Request, response: Response | null) {
    record.completedAt = Date.now()
    record.status = response?.status() ?? null
    record.outcome = !response ? 'failed' : response.ok() ? 'success' : 'error'
    record.networkMs = networkMs(request)
  }

  snapshot(): ReadLogSnapshot {
    return { reads: structuredClone(this.#reads), truncated: this.#truncated }
  }
}

// Timing fields are -1 when the browser did not measure them, for example a cache hit.
function networkMs(request: Request): number | null {
  const { responseEnd } = request.timing()
  return responseEnd >= 0 ? Math.round(responseEnd) : null
}
