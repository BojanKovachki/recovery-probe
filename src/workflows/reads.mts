import { setTimeout as sleep } from 'node:timers/promises'
import type { Page, Response } from 'playwright'
import { pageIdentity } from '../core/urls.mjs'
import { isReadRequest } from '../transports/http/reads.mjs'

export interface DesktopDiscovery {
  pageUrl: string
  endpoints: {
    endpoint: string
    method: string
    observed: number
    queryValuesOmitted: boolean
  }[]
  limitation: string
}

/** Reload the current renderer and observe metadata only. No faults are injected. */
export async function discoverDesktop(
  page: Page,
  {
    durationMs = 5000,
    maxEndpoints = 50,
  }: { durationMs?: number; maxEndpoints?: number } = {},
): Promise<DesktopDiscovery> {
  if (!Number.isInteger(durationMs) || durationMs < 200 || durationMs > 30000)
    throw new Error('durationMs must be 200–30000')
  const found = new Map<string, DesktopDiscovery['endpoints'][number]>()
  const listener = (response: Response) => {
    const request = response.request()
    if (!isReadRequest(request, page) || !response.ok()) return
    const contentType = response.headers()['content-type'] ?? ''
    if (!/\bjson\b|\+json\b/i.test(contentType)) return
    const endpoint = pageIdentity(response.url())
    if (!/^https?:/.test(endpoint)) return
    const known = found.get(endpoint)
    if (known) {
      known.observed += 1
      return
    }
    if (found.size >= maxEndpoints) return
    found.set(endpoint, {
      endpoint,
      method: 'GET',
      observed: 1,
      queryValuesOmitted: Boolean(new URL(response.url()).search),
    })
  }
  page.on('response', listener)
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 })
    await sleep(durationMs)
  } finally {
    page.off('response', listener)
  }
  return {
    pageUrl: pageIdentity(page.url()),
    endpoints: [...found.values()],
    limitation:
      'Only successful renderer GET fetch/XHR JSON responses observed during this reload. Query variants are grouped by origin and path. Native/IPC traffic, service-worker-only traffic, and untouched routes are not covered.',
  }
}
