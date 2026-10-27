import type { Page } from 'playwright'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  readRegion,
  type ObservationReadInput,
} from '../../core/region-read.mjs'
import { summarizeRegion } from '../../core/screen.mjs'
import type { ObservationAdapter } from './adapters.mjs'
import { observationConfig, type ObservationConfig } from './config.mjs'
import { installObserverKit, removeObserverKit } from './kit.mjs'
import { pageReadInput, pageSelectors } from './page-input.mjs'
import type { ReadSnapshot } from './reads.mjs'
import { ObservationRecorder, type Clock, type Sample } from './recorder.mjs'
import type {
  ObservationOperator,
  ObservationReport,
  TimelineEvent,
} from './report.mjs'
import { summarizeRows } from './rows.mjs'
import { boundedUiRead } from './ui-read.mjs'

export interface ObservationHooks {
  signal?: AbortSignal
  /** Returns true to open a new operator interval. */
  takeMarker?: () => boolean
  onReady?: () => unknown
  onInterval?: (index: number) => unknown
  onSample?: (event: TimelineEvent) => unknown
  operator?: (context: {
    mark: () => Promise<number | null>
    signal: AbortSignal
    elapsed: () => number
  }) => unknown
}

const MAX_INTERVALS = 50
const OPERATOR_STOP_MS = 5000

/**
 * Observe only. No reload, navigation, routing, focus changes or final UI reset.
 * An optional `operator` function may act on the app (for example explicit --steps); it
 * receives `mark()` to open a new interval and its outcome is reported separately.
 */
export async function runObservation(
  page: Page,
  input: unknown,
  adapter: ObservationAdapter,
  hooks: ObservationHooks = {},
): Promise<ObservationReport> {
  return new Capture(page, observationConfig(input), adapter, hooks).run()
}

/** Samples the screen and read counters until the capture ends, then cleans up. */
class Capture {
  readonly #page: Page
  readonly #config: ObservationConfig
  readonly #adapter: ObservationAdapter
  readonly #hooks: ObservationHooks
  readonly #recorder: ObservationRecorder
  readonly #kitToken = randomUUID()
  readonly #readInput: ObservationReadInput
  readonly #markerRequests: { resolve?: (index: number | null) => void }[] = []
  readonly #operatorAbort = new AbortController()
  #started = 0
  /** Set once the adapter is reading; the capture has a clock from then on. */
  #clock?: Clock
  #lastSnapshot?: ReadSnapshot
  #pageErrors = 0
  #newDocument = false
  #adapterStarted = false
  #operatorRun?: Promise<ObservationOperator>

  #elapsed = () => Math.round(performance.now() - this.#started)
  #countPageError = () => {
    this.#pageErrors++
  }
  // A document load destroys the state being investigated. SPA route changes are allowed.
  #noteDocumentLoad = () => {
    this.#newDocument = true
  }

  constructor(
    page: Page,
    config: ObservationConfig,
    adapter: ObservationAdapter,
    hooks: ObservationHooks,
  ) {
    this.#page = page
    this.#config = config
    this.#adapter = adapter
    this.#hooks = hooks
    this.#recorder = new ObservationRecorder(config)
    this.#readInput = pageReadInput(config, this.#kitToken)
  }

  async run(): Promise<ObservationReport> {
    const report = this.#recorder.report
    const signal = this.#hooks.signal
    try {
      await this.#start()
      await this.#sampleUntilDone()
    } catch (error) {
      report.status = signal?.aborted ? 'interrupted' : 'incomplete'
      if (!signal?.aborted) report.error = (error as Error).message
    } finally {
      await this.#finish()
    }
    return report
  }

  #requireSameDocument() {
    if (this.#newDocument)
      throw Error(
        'DOCUMENT_REPLACED: capture stopped; the in-memory state may have been reset',
      )
  }

  async #start() {
    const report = this.#recorder.report
    await this.#installKit()
    this.#page.on('pageerror', this.#countPageError)
    this.#page.on('domcontentloaded', this.#noteDocumentLoad)
    this.#adapterStarted = true
    await this.#adapter.start()
    report.metadata.ipcHook = this.#adapter.metadata?.() ?? null
    this.#started = performance.now()
    this.#clock = { elapsed: this.#elapsed, startedEpoch: Date.now() }
    this.#lastSnapshot = await this.#adapter.snapshot()
    report.startedAt = this.#lastSnapshot.startedAt
    this.#recorder.openInterval(this.#lastSnapshot, this.#elapsed())
    await this.#hooks.onReady?.()
    this.#startOperator()
  }

  /** One renderer call installs the kit and validates every selector, mounted or not. */
  async #installKit() {
    const token = this.#kitToken
    const actions = this.#config.actions ?? []
    const validate = pageSelectors(this.#config)
    await boundedUiRead(
      () =>
        this.#page.evaluate(installObserverKit, { token, actions, validate }),
      this.#hooks.signal,
    )
  }

  #startOperator() {
    const operator = this.#hooks.operator
    if (!operator) return
    const abort = this.#operatorAbort
    const mark = () =>
      new Promise<number | null>((resolve) =>
        this.#markerRequests.push({ resolve }),
      )
    this.#operatorRun = Promise.resolve()
      .then(() =>
        operator({ mark, signal: abort.signal, elapsed: this.#elapsed }),
      )
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

  async #sampleUntilDone() {
    const report = this.#recorder.report
    const { observationMs, sampleMs } = this.#config
    while (true) {
      if (this.#hooks.signal?.aborted) {
        report.status = 'interrupted'
        return
      }
      this.#requireSameDocument()
      await this.#openMarkedInterval()
      await this.#sample()
      const runMs = performance.now() - this.#started
      if (runMs >= observationMs) {
        report.status = 'complete'
        return
      }
      const waitMs = Math.min(sampleMs, Math.max(0, observationMs - runMs))
      await sleep(waitMs)
    }
  }

  #nextMarker() {
    if (this.#markerRequests.length) return this.#markerRequests.shift()
    return this.#hooks.takeMarker?.() ? {} : null
  }

  async #openMarkedInterval() {
    const marker = this.#nextMarker()
    if (!marker) return
    if (this.#recorder.report.intervals.length >= MAX_INTERVALS)
      throw Error('INTERVAL_LIMIT_REACHED')
    // Use a fresh boundary snapshot; do not attribute between-sample reads to the next interval.
    const boundary = await this.#adapter.snapshot()
    this.#lastSnapshot = boundary
    this.#recorder.closeInterval(boundary, this.#elapsed())
    const interval = this.#recorder.openInterval(boundary, this.#elapsed())
    await this.#hooks.onInterval?.(interval.index)
    marker.resolve?.(interval.index)
  }

  async #readScreen(): Promise<Sample> {
    const c = this.#config
    const beforeStart = performance.now()
    const before = await this.#adapter.snapshot()
    const uiStart = performance.now()
    const fromMs = this.#elapsed()
    const { rendererReadMs, rows, actions, ...raw } = await boundedUiRead(
      () => this.#page.evaluate(readRegion, this.#readInput),
      this.#hooks.signal,
    )
    const summarizeStart = performance.now()
    // A read without text or content (an absent or hidden region) summarizes to itself.
    const ui = summarizeRegion(raw)
    const summarizedRows = c.rows ? summarizeRows(rows, c.rows) : null
    const afterStart = performance.now()
    const after = await this.#adapter.snapshot()
    const afterEnd = performance.now()
    return {
      before,
      after,
      fromMs,
      ui,
      rows: summarizedRows,
      actions,
      phases: {
        beforeSnapshotMs: uiStart - beforeStart,
        uiRoundTripMs: summarizeStart - uiStart,
        rendererReadMs,
        summarizeMs: afterStart - summarizeStart,
        afterSnapshotMs: afterEnd - afterStart,
      },
    }
  }

  async #sample() {
    const sample = await this.#readScreen()
    this.#requireSameDocument()
    this.#lastSnapshot = sample.after
    const event = this.#recorder.addSample(
      sample,
      this.#clock!,
      this.#pageErrors,
    )
    await this.#hooks.onSample?.(event)
  }

  async #finish() {
    const recorder = this.#recorder
    this.#operatorAbort.abort()
    for (const pending of this.#markerRequests) pending.resolve?.(null)
    await this.#finishOperator()
    const elapsedMs = this.#clock ? this.#elapsed() : 0
    if (recorder.intervalOpen)
      recorder.closeInterval(this.#lastSnapshot, elapsedMs)
    recorder.endSampling(elapsedMs, this.#lastSnapshot)
    this.#page.off('pageerror', this.#countPageError)
    this.#page.off('domcontentloaded', this.#noteDocumentLoad)
    await this.#removeKit()
    await this.#stopAdapter()
    recorder.conclude()
  }

  async #finishOperator() {
    if (!this.#operatorRun) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // An operator that ignores the stop signal must not hold cleanup hostage.
    const outcome = await Promise.race([
      this.#operatorRun,
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
    this.#recorder.report.operator = outcome
    clearTimeout(timer)
    if (outcome.status !== 'complete')
      this.#recorder.gap('OPERATOR_STEPS_INCOMPLETE')
  }

  // Bounded: a replaced or unresponsive document must not delay owned IPC cleanup.
  async #removeKit() {
    const token = this.#kitToken
    try {
      await boundedUiRead(
        () => this.#page.evaluate(removeObserverKit, token),
        undefined,
        1000,
      )
    } catch {
      /* Nothing left to remove. */
    }
  }

  async #stopAdapter() {
    if (!this.#adapterStarted) return
    const report = this.#recorder.report
    try {
      report.cleanupEvidence = (await this.#adapter.stop()) ?? null
      report.cleanup = 'complete'
    } catch (error) {
      report.cleanup = 'unverified'
      report.cleanupError = (error as Error).message
      report.status = 'incomplete'
    }
  }
}
