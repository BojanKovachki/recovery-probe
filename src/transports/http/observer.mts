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

interface RequestMeta {
  row: ReadChannelStats
  start: number
  injected: boolean
  afterFault: boolean
  target: boolean
}

export async function observeHttp(
  page: Page,
  {
    endpoint,
    requiredEndpoints = [],
    fault,
    times = 1,
    skip = 0,
  }: HttpObserverOptions,
) {
  const channels: Record<string, ReadChannelStats> = Object.fromEntries(
    [endpoint, ...requiredEndpoints].map((e) => [
      e,
      {
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
      },
    ]),
  )
  const startedAt = Date.now()
  const requests = new Map<Request, RequestMeta>(),
    coverage = new Map<
      string,
      {
        method: string
        endpoint: string
        supported: boolean
        tested: boolean
        reason: string | undefined
      }
    >(),
    operations = new Set<Promise<unknown>>()
  let skipped = 0,
    reserved = 0,
    applied = 0,
    injectedAt: number | null = null,
    successfulAfterFault = 0,
    active = true,
    injectionError = false
  let routed = Boolean(fault)
  const mainRead = (r: Request) => {
    try {
      return (
        r.frame() === page.mainFrame() &&
        ['fetch', 'xhr'].includes(r.resourceType())
      )
    } catch {
      return false
    }
  }
  const request = (r: Request) => {
    if (!mainRead(r)) return
    const url = pageIdentity(r.url())
    if (coverage.size < 100)
      coverage.set(`${r.method()} ${url}`, {
        method: r.method(),
        endpoint: url,
        supported: r.method() === 'GET',
        tested: r.method() === 'GET' && url === endpoint,
        reason:
          r.method() !== 'GET'
            ? 'Non-GET injection is unsupported'
            : url !== endpoint
              ? 'Observed, not selected for injection'
              : undefined,
      })
    const row = r.method() === 'GET' && channels[url]
    if (!row) return
    row.calls++
    row.realCalls++
    row.pending++
    row.firstReadAt ??= Date.now()
    row.lastReadAt = Date.now()
    requests.set(r, {
      row,
      start: performance.now(),
      injected: false,
      afterFault: reserved === times && injectedAt !== null,
      target: url === endpoint,
    })
  }
  const finish = async (r: Request, failed: boolean) => {
    const meta = requests.get(r)
    if (!meta) return
    requests.delete(r)
    const response = failed ? null : await r.response().catch(() => null)
    meta.row.pending--
    if (meta.injected) return
    const completed = Date.now()
    meta.row.firstCompletedAt ??= completed
    meta.row.lastCompletedAt = completed
    meta.row.maxDurationMs = Math.max(
      meta.row.maxDurationMs,
      Math.round(performance.now() - meta.start),
    )
    if (response?.ok()) {
      meta.row.successes++
      meta.row.lastSuccessAt = completed
      if (meta.target && meta.afterFault) successfulAfterFault++
    } else meta.row.errors++
  }
  const finished = (r: Request) => {
    const p = finish(r, false)
    operations.add(p)
    p.finally(() => operations.delete(p))
  }
  const failed = (r: Request) => {
    const p = finish(r, true)
    operations.add(p)
    p.finally(() => operations.delete(p))
  }
  const match = (url: URL) => pageIdentity(url.href) === endpoint
  const handler = async (route: Route) => {
    const r = route.request()
    if (!active || reserved >= times || !mainRead(r) || r.method() !== 'GET')
      return route.fallback()
    if (skipped < skip) {
      skipped++
      return route.fallback()
    }
    reserved++
    injectedAt ??= Date.now()
    const meta = requests.get(r)
    if (meta) {
      meta.injected = true
      meta.row.realCalls--
    }
    const op = (async () => {
      try {
        // The handler is only installed when there is a fault.
        await fulfillFault(route, fault!)
        applied++
      } catch {
        injectionError = true
      }
    })()
    operations.add(op)
    try {
      await op
    } finally {
      operations.delete(op)
    }
  }
  page.on('request', request)
  page.on('requestfinished', finished)
  page.on('requestfailed', failed)
  try {
    if (fault) await page.route(match, handler)
  } catch (error) {
    page.off('request', request)
    page.off('requestfinished', finished)
    page.off('requestfailed', failed)
    throw error
  }
  return {
    snapshot: () => ({
      startedAt,
      capturedAt: Date.now(),
      injected: applied,
      injectedAt,
      successfulAfterFault,
      injectionError,
      armed:
        fault && active && reserved < times
          ? { remaining: times - reserved }
          : null,
      channels: structuredClone(channels),
    }),
    coverage: () => [...coverage.values()],
    async disarm() {
      active = false
      if (routed) {
        await page.unroute(match, handler)
        routed = false
      }
      await Promise.allSettled([...operations])
    },
    async stop() {
      active = false
      try {
        if (routed) {
          await page.unroute(match, handler)
          routed = false
        }
        await Promise.allSettled([...operations])
      } finally {
        page.off('request', request)
        page.off('requestfinished', finished)
        page.off('requestfailed', failed)
      }
    },
  }
}
