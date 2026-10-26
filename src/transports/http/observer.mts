import { performance } from 'node:perf_hooks'
import type { Page, Request, Route } from 'playwright'
import { pageIdentity } from '../../core/urls.mjs'
import type { FaultKind } from '../../core/faults.mjs'
import { fulfillFault } from './route.mjs'

/** Read counters for one endpoint, in the same shape as an IPC channel row. */
export interface ReadChannelStats {
  calls: number
  realCalls: number
  successes: number
  errors: number
  pending: number
  maxDurationMs: number
  firstReadAt: number | null
  lastReadAt: number | null
  firstCompletedAt: number | null
  lastCompletedAt: number | null
  lastSuccessAt: number | null
}

export interface HttpObserverOptions {
  endpoint: string
  requiredEndpoints?: string[]
  fault?: FaultKind
  times?: number
  /** Matching reads that pass before the first fault: 1 fails the 2nd read. */
  skip?: number
}

/** A request the page made, and whether it could be or was selected for a fault. */
export interface ReadCoverage {
  method: string
  endpoint: string
  supported: boolean
  tested: boolean
  reason: string | undefined
}

interface RequestMeta {
  row: ReadChannelStats
  start: number
  injected: boolean
  afterFault: boolean
  target: boolean
}

const MAX_COVERAGE = 100

const emptyRow = (): ReadChannelStats => ({
  calls: 0,
  realCalls: 0,
  successes: 0,
  errors: 0,
  pending: 0,
  maxDurationMs: 0,
  firstReadAt: null,
  lastReadAt: null,
  firstCompletedAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
})

/** Counts the page's reads of the endpoints and, given a fault, fails the target read. */
export async function observeHttp(
  page: Page,
  options: HttpObserverOptions,
): Promise<HttpObserver> {
  const observer = new HttpObserver(page, options)
  await observer.attach()
  return observer
}

class HttpObserver {
  readonly #page: Page
  readonly #endpoint: string
  readonly #fault: FaultKind | undefined
  readonly #times: number
  readonly #skip: number
  readonly #channels: Record<string, ReadChannelStats>
  readonly #startedAt: number
  readonly #requests = new Map<Request, RequestMeta>()
  readonly #coverage = new Map<string, ReadCoverage>()
  readonly #operations = new Set<Promise<unknown>>()
  #skipped = 0
  #reserved = 0
  #applied = 0
  #injectedAt: number | null = null
  #successfulAfterFault = 0
  #active = true
  #injectionError = false
  #routed: boolean

  constructor(
    page: Page,
    {
      endpoint,
      requiredEndpoints = [],
      fault,
      times = 1,
      skip = 0,
    }: HttpObserverOptions,
  ) {
    this.#page = page
    this.#endpoint = endpoint
    this.#fault = fault
    this.#times = times
    this.#skip = skip
    this.#channels = Object.fromEntries(
      [endpoint, ...requiredEndpoints].map((e) => [e, emptyRow()]),
    )
    this.#startedAt = Date.now()
    this.#routed = Boolean(fault)
  }

  async attach() {
    const page = this.#page
    page.on('request', this.#onRequest)
    page.on('requestfinished', this.#onFinished)
    page.on('requestfailed', this.#onFailed)
    try {
      if (this.#fault) await page.route(this.#match, this.#onRoute)
    } catch (error) {
      this.#detach()
      throw error
    }
  }

  snapshot() {
    const armed =
      this.#fault && this.#active && this.#reserved < this.#times
        ? { remaining: this.#times - this.#reserved }
        : null
    return {
      startedAt: this.#startedAt,
      capturedAt: Date.now(),
      injected: this.#applied,
      injectedAt: this.#injectedAt,
      successfulAfterFault: this.#successfulAfterFault,
      injectionError: this.#injectionError,
      armed,
      channels: structuredClone(this.#channels),
    }
  }

  coverage() {
    return [...this.#coverage.values()]
  }

  /** Stops faulting and waits for the injected responses. */
  async disarm() {
    this.#active = false
    if (this.#routed) {
      await this.#page.unroute(this.#match, this.#onRoute)
      this.#routed = false
    }
    await Promise.allSettled([...this.#operations])
  }

  /** Disarms, then stops listening. */
  async stop() {
    try {
      await this.disarm()
    } finally {
      this.#detach()
    }
  }

  readonly #onRequest = (r: Request) => this.#count(r)
  readonly #onFinished = (r: Request) => this.#track(this.#finish(r, false))
  readonly #onFailed = (r: Request) => this.#track(this.#finish(r, true))
  readonly #onRoute = (route: Route) => this.#inject(route)
  readonly #match = (url: URL) => pageIdentity(url.href) === this.#endpoint

  #detach() {
    this.#page.off('request', this.#onRequest)
    this.#page.off('requestfinished', this.#onFinished)
    this.#page.off('requestfailed', this.#onFailed)
  }

  #isMainRead(r: Request) {
    try {
      return (
        r.frame() === this.#page.mainFrame() &&
        ['fetch', 'xhr'].includes(r.resourceType())
      )
    } catch {
      return false
    }
  }

  #count(r: Request) {
    if (!this.#isMainRead(r)) return
    const url = pageIdentity(r.url())
    this.#cover(r.method(), url)
    const row = r.method() === 'GET' && this.#channels[url]
    if (!row) return
    row.calls++
    row.realCalls++
    row.pending++
    row.firstReadAt ??= Date.now()
    row.lastReadAt = Date.now()
    this.#requests.set(r, {
      row,
      start: performance.now(),
      injected: false,
      afterFault: this.#reserved === this.#times && this.#injectedAt !== null,
      target: url === this.#endpoint,
    })
  }

  #cover(method: string, url: string) {
    if (this.#coverage.size >= MAX_COVERAGE) return
    const selected = url === this.#endpoint
    const reason =
      method !== 'GET'
        ? 'Non-GET injection is unsupported'
        : selected
          ? undefined
          : 'Observed, not selected for injection'
    this.#coverage.set(`${method} ${url}`, {
      method,
      endpoint: url,
      supported: method === 'GET',
      tested: method === 'GET' && selected,
      reason,
    })
  }

  #track(operation: Promise<unknown>) {
    this.#operations.add(operation)
    operation.finally(() => this.#operations.delete(operation))
  }

  async #finish(r: Request, failed: boolean) {
    const meta = this.#requests.get(r)
    if (!meta) return
    this.#requests.delete(r)
    const response = failed ? null : await r.response().catch(() => null)
    const row = meta.row
    row.pending--
    if (meta.injected) return
    const completed = Date.now()
    row.firstCompletedAt ??= completed
    row.lastCompletedAt = completed
    row.maxDurationMs = Math.max(
      row.maxDurationMs,
      Math.round(performance.now() - meta.start),
    )
    if (response?.ok()) {
      row.successes++
      row.lastSuccessAt = completed
      if (meta.target && meta.afterFault) this.#successfulAfterFault++
    } else row.errors++
  }

  async #inject(route: Route) {
    const r = route.request()
    if (
      !this.#active ||
      this.#reserved >= this.#times ||
      !this.#isMainRead(r) ||
      r.method() !== 'GET'
    )
      return route.fallback()
    if (this.#skipped < this.#skip) {
      this.#skipped++
      return route.fallback()
    }
    this.#reserved++
    this.#injectedAt ??= Date.now()
    const meta = this.#requests.get(r)
    if (meta) {
      meta.injected = true
      meta.row.realCalls--
    }
    const operation = (async () => {
      try {
        // The handler is only installed when there is a fault.
        await fulfillFault(route, this.#fault!)
        this.#applied++
      } catch {
        this.#injectionError = true
      }
    })()
    this.#operations.add(operation)
    try {
      await operation
    } finally {
      this.#operations.delete(operation)
    }
  }
}

export type { HttpObserver }
