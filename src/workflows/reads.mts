import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Page, Response } from 'playwright'
import type { IpcIdentity, IpcSnapshot } from '../ipc-probe.cjs'
import { pageIdentity } from '../core/urls.mjs'
import { isReadRequest } from '../transports/http/reads.mjs'
import {
  endObservation,
  stillObserving,
  waitForSettledCalls,
} from '../transports/ipc/control.mjs'
import type { IpcInspector } from '../transports/ipc/inspector.mjs'

const RELOAD_TIMEOUT_MS = 15000

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
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: RELOAD_TIMEOUT_MS,
    })
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

export interface IpcReads {
  pageUrl: string
  /** In the order of their first call. */
  channels: {
    channel: string
    calls: number
    errors: number
    /** Calls by method label, when the hook's classify labels this channel's calls. */
    methods?: Record<string, number>
  }[]
  limitation: string
}

/**
 * Reloads the window the IPC hook watches and lists the calls it makes on the
 * channels the hook captured. No faults are injected.
 */
export async function discoverIpcReads(
  page: Page,
  control: IpcInspector,
  identity: IpcIdentity,
  { durationMs = 5000 }: { durationMs?: number } = {},
): Promise<IpcReads> {
  if (!Number.isInteger(durationMs) || durationMs < 200 || durationMs > 30000)
    throw new Error('durationMs must be 200–30000')
  const [channel, ...requiredChannels] = identity.registered
  if (!channel)
    throw new Error(
      "The hook hasn't captured any channel: list the app's channels in its options, and load it before the app registers its handlers",
    )
  // The hook refuses a plan while another is active or earlier calls are pending.
  const previous = await control.call('snapshot')
  if (previous?.armed || previous?.observingUntil)
    throw new Error('IPC_PLAN_ALREADY_ACTIVE')
  await waitForSettledCalls(control, RELOAD_TIMEOUT_MS)
  const id = randomUUID() // A lost begin reply still requires scoped cleanup.
  let snapshot: IpcSnapshot | null
  try {
    await control.call('begin', {
      id,
      channel,
      requiredChannels,
      observation: true,
      ttlMs: RELOAD_TIMEOUT_MS + durationMs + 5000,
    })
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: RELOAD_TIMEOUT_MS,
    })
    await sleep(durationMs)
    snapshot = await control.call('snapshot')
  } finally {
    await endObservation(control, id)
  }
  if (!stillObserving(snapshot, id, identity.senderId))
    throw new Error('IPC_OBSERVATION_COVERAGE_LOST')
  return {
    pageUrl: pageIdentity(page.url()),
    channels: calledChannels(snapshot),
    limitation:
      "Calls from this window on the channels the hook captured, during this reload, without faults. Writes are listed too. Channels the hook wasn't given, pushes from the main process, and calls after the window are not covered. Arguments and results are never recorded.",
  }
}

type ChannelRow = IpcSnapshot['channels'][string]

// Older hooks record only the time of a first call, which another can share.
const byFirstCall = (
  [, a]: [string, ChannelRow],
  [, b]: [string, ChannelRow],
) =>
  a.firstReadOrder != null && b.firstReadOrder != null
    ? a.firstReadOrder - b.firstReadOrder
    : (a.firstReadAt ?? 0) - (b.firstReadAt ?? 0)

function calledChannels(snapshot: IpcSnapshot): IpcReads['channels'] {
  return Object.entries(snapshot.channels)
    .filter(([, row]) => row.calls > 0)
    .sort(byFirstCall)
    .map(([channel, row]) => {
      const labels = Object.entries(row.methods ?? {})
        .filter(([, method]) => method.calls > 0)
        .map(([label, method]) => [label, method.calls] as const)
      // Without a label of its own, every call is 'unclassified'.
      const labelled = labels.some(([label]) => label !== 'unclassified')
      return {
        channel,
        calls: row.calls,
        errors: row.errors,
        ...(labelled ? { methods: Object.fromEntries(labels) } : {}),
      }
    })
}
