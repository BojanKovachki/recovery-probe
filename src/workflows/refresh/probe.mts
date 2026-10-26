import { performance } from 'node:perf_hooks'
import type { Page } from 'playwright'
import { readRegion, summarizeRegion } from '../../core/screen.mjs'
import type { RefreshConfig } from './config.mjs'
import type {
  Emitted,
  Observed,
  RefreshAdapter,
  RefreshReport,
  RefreshSnapshot,
  Sample,
} from './types.mjs'

const POLL_MS = 50
const MAX_EVENTS = 100

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const settled = (s: RefreshSnapshot) =>
  Object.values(s.channels).every((r) => r.pending === 0)

export const anyErrors = (s: RefreshSnapshot) =>
  Object.values(s.channels).some((r) => r.errors)

/** How long a phase is watched, what ends it early, and whether an abort may cut it short. */
export interface ObserveOptions {
  ms: number
  predicate?: (value: Sample, stable: boolean) => boolean
  ignoreAbort?: boolean
  /** Watch the whole window, and report the predicate only at its end. */
  fullWindow?: boolean
}

/** Adds `event` to `timeline` when its screen or counters differ from the last one kept. */
function recordChange(
  timeline: Observed['timeline'],
  event: Observed['timeline'][number],
  signature: string,
) {
  const last = timeline.at(-1)
  if (
    timeline.length < MAX_EVENTS &&
    (JSON.stringify(last?.ui) !== signature ||
      JSON.stringify(last?.snapshot) !== JSON.stringify(event.snapshot))
  )
    timeline.push(event)
}

/** Reloads, watches and triggers the page for a refresh experiment. */
export class RefreshProbe {
  readonly target: string
  /** The calibrated healthy load; idle windows must keep showing it. */
  baseline?: Observed
  readonly #page: Page
  readonly #config: RefreshConfig
  readonly #adapter: RefreshAdapter
  readonly #signal?: AbortSignal
  readonly #report: RefreshReport
  readonly #required: string[]
  readonly #initialUrl: string
  #errors = 0
  #countError = () => this.#errors++

  constructor(
    page: Page,
    config: RefreshConfig,
    adapter: RefreshAdapter,
    { signal, report }: { signal?: AbortSignal; report: RefreshReport },
  ) {
    this.#page = page
    this.#config = config
    this.#adapter = adapter
    this.#signal = signal
    this.#report = report
    this.target = config.transport === 'http' ? config.endpoint : config.channel
    this.#required =
      config.transport === 'http'
        ? config.requiredEndpoints
        : config.requiredChannels
    this.#initialUrl = page.url()
  }

  /** Uncaught page errors since the probe started listening. */
  get errors() {
    return this.#errors
  }

  listen() {
    this.#page.on('pageerror', this.#countError)
  }

  stopListening() {
    this.#page.off('pageerror', this.#countError)
  }

  checkAbort() {
    if (this.#signal?.aborted) throw Error('ABORTED')
  }

  async sample(): Promise<Sample> {
    if (this.#page.url() !== this.#initialUrl) throw Error('TARGET_NAVIGATED')
    const ui = summarizeRegion(
      await this.#page.evaluate(readRegion, this.#config.regionSelector),
    )
    if (!ui.visible || !ui.online) throw Error('ENVIRONMENT_BLOCKED')
    const snapshot = await this.#adapter.snapshot()
    if (snapshot.injectionError) throw Error('INJECTION_ERROR')
    return { ui, snapshot }
  }

  /** Samples until the predicate holds or the window ends. */
  async observe(options: ObserveOptions): Promise<Observed> {
    const { ms, predicate, ignoreAbort = false, fullWindow = false } = options
    const start = performance.now()
    const timeline: Observed['timeline'] = []
    let previous: string | undefined,
      stableSince = start
    while (true) {
      if (!ignoreAbort) this.checkAbort()
      const last = await this.sample()
      const signature = JSON.stringify(last.ui)
      if (signature !== previous) {
        previous = signature
        stableSince = performance.now()
      }
      const elapsedMs = Math.round(performance.now() - start)
      recordChange(timeline, { elapsedMs, ...last }, signature)
      const stable = performance.now() - stableSince >= this.#config.settleMs
      if (!fullWindow && predicate?.(last, stable))
        return { ...last, elapsedMs, timeline, ready: true }
      if (performance.now() - start >= ms) {
        const ready = Boolean(fullWindow && predicate?.(last, stable))
        return { ...last, elapsedMs, timeline, ready }
      }
      await sleep(POLL_MS)
    }
  }

  /** Reloads and watches until the page is healthy, matching `expected` when given. */
  async load(
    expected: string | undefined,
    ignoreAbort = false,
    calibrate = false,
  ) {
    const initialErrors = this.#errors
    await this.#adapter.begin()
    await this.#page.reload({
      waitUntil: 'domcontentloaded',
      timeout: this.#config.baselineTimeoutMs,
    })
    const result = await this.observe({
      ms: this.#config.baselineTimeoutMs,
      predicate: (v, stable) => this.#healthy(v, stable, expected),
      ignoreAbort,
      fullWindow: calibrate,
    })
    if (this.#errors !== initialErrors) result.ready = false
    return result
  }

  /** An idle window with no target read, so the next read can be tied to the trigger. */
  async quiet() {
    await this.#adapter.begin()
    const phase = await this.observe({ ms: this.#config.idleMs })
    const snapshot = phase.snapshot
    if (snapshot.channels[this.target].calls || !settled(snapshot)) {
      this.#report.stoppedObservation = phase
      throw Error('ATTRIBUTION_AMBIGUOUS: target traffic during idle control')
    }
    if (
      this.baseline &&
      phase.ui.fingerprint !== this.baseline.ui.fingerprint
    ) {
      this.#report.stoppedObservation = phase
      throw Error('CONTROL_UNSTABLE_DURING_IDLE')
    }
    return phase
  }

  /** Dispatches the trigger event in the page, after checking nothing read the target first. */
  async fire(): Promise<Emitted> {
    this.checkAbort()
    const before = await this.sample()
    if (before.snapshot.channels[this.target].calls)
      throw Error('ATTRIBUTION_AMBIGUOUS: target read before trigger')
    return this.#page.evaluate((name) => {
      const firedAt = Date.now()
      window.dispatchEvent(new Event(name))
      return {
        firedAt,
        event: name,
        synthesized: true as const,
        online: navigator.onLine,
        visibility: document.visibilityState,
      }
    }, this.#config.trigger.name)
  }

  #healthy(value: Sample, stable: boolean, expected?: string) {
    const channels = value.snapshot.channels
    return (
      stable &&
      !value.ui.loading &&
      !anyErrors(value.snapshot) &&
      settled(value.snapshot) &&
      channels[this.target].successes > 0 &&
      this.#required.every((k) => channels[k].successes > 0) &&
      (!expected || value.ui.fingerprint === expected)
    )
  }
}
