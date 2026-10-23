import type { Browser } from 'playwright'
import { connectDesktop, desktopPages } from '../../targets/cdp.mjs'
import { connectIpcInspector } from '../../transports/ipc/inspector.mjs'
import {
  confirmSameWindow,
  type IpcFault,
} from '../../transports/ipc/control.mjs'
import { ipcRefreshAdapter } from '../../transports/session.mjs'
import type { IpcSnapshot } from '../../ipc-probe.cjs'
import { runDiscovery, type DiscoveryResult } from './run.mjs'
import type { DiscoveryScreenshot } from './screenshots.mjs'

export interface IpcDiscoveryConfig {
  cdp: string
  inspector: string
  channel: string
  requiredChannels: string[]
  observationMs: number
  baselineTimeoutMs: number
  repeats: number
  settleMs: number
  regionSelector?: string
  restoreWindow: boolean
}

export type IpcDiscoveryInput = Partial<IpcDiscoveryConfig> &
  Pick<IpcDiscoveryConfig, 'channel'>

export interface IpcDiscoveryReport extends DiscoveryResult<
  IpcFault,
  IpcSnapshot
> {
  schemaVersion: 2
  mode: string
  channel: string
  generatedAt: string
  readiness: DiscoveryResult<IpcFault, IpcSnapshot>['readiness'] & {
    strategy: string
    calibrationRuns: number
    calibrationWindowMs: number
    relevantChannels: string[]
    settleMs: number
    note: string
  }
  limitation: string
  coverage?: {
    watchedChannels: string[]
    unobservedRegisteredChannels: string[]
    gaps: string[]
  }
}

export function discoveryConfig(input: IpcDiscoveryInput): IpcDiscoveryConfig {
  const c: Record<string, unknown> = {
    cdp: 'http://127.0.0.1:9222',
    inspector: 'http://127.0.0.1:9229',
    channel: undefined,
    requiredChannels: [],
    observationMs: 8000,
    baselineTimeoutMs: 15000,
    repeats: 3,
    settleMs: 800,
    regionSelector: undefined,
    restoreWindow: false,
  }
  for (const key of Object.keys(c))
    if (Object.hasOwn(input, key))
      c[key] = (input as Record<string, unknown>)[key]
  if (typeof c.channel !== 'string' || !c.channel.trim())
    throw new Error('channel is required (an explicitly allowed read channel)')
  if (
    !Array.isArray(c.requiredChannels) ||
    c.requiredChannels.some(
      (x) => typeof x !== 'string' || !x.trim() || x === c.channel,
    ) ||
    new Set(c.requiredChannels).size !== c.requiredChannels.length
  )
    throw new Error('Invalid requiredChannels')
  for (const key of ['observationMs', 'baselineTimeoutMs'])
    if (
      typeof c[key] !== 'number' ||
      !Number.isInteger(c[key]) ||
      c[key] < 500 ||
      c[key] > 30000
    )
      throw new Error(`${key} must be 500–30000`)
  if (
    typeof c.repeats !== 'number' ||
    !Number.isInteger(c.repeats) ||
    c.repeats < 1 ||
    c.repeats > 3
  )
    throw new Error('repeats must be 1–3')
  if (
    typeof c.settleMs !== 'number' ||
    !Number.isInteger(c.settleMs) ||
    c.settleMs < 200 ||
    c.settleMs > 5000
  )
    throw new Error('settleMs must be 200–5000')
  if (
    c.regionSelector !== undefined &&
    (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())
  )
    throw new Error('Invalid regionSelector')
  if (typeof c.restoreWindow !== 'boolean')
    throw new Error('restoreWindow must be boolean')
  return c as unknown as IpcDiscoveryConfig
}

export async function discoverIpc(
  input: IpcDiscoveryInput,
  options: { screenshot?: DiscoveryScreenshot } = {},
): Promise<IpcDiscoveryReport> {
  const config = discoveryConfig(input)
  const report: IpcDiscoveryReport = {
    schemaVersion: 2,
    mode: 'experimental IPC discovery',
    channel: config.channel,
    generatedAt: new Date().toISOString(),
    baselines: [],
    results: [],
    findings: [],
    finalReset: 'not-verified',
    ok: false,
    readiness: {
      strategy: 'bounded-end-state-calibration',
      calibrationRuns: 3,
      calibrationWindowMs: config.baselineTimeoutMs,
      calibrationComplete: false,
      relevantChannels: [config.channel, ...config.requiredChannels],
      settleMs: config.settleMs,
      note: 'Relevant channels are explicit. Matching stable end states do not prove completeness beyond the calibration window.',
    },
    limitation:
      'One explicitly allowed IPC read on the current screen. Synthetic renderer-boundary faults only. Structural changes and language hints produce leads, not proven product defects. No source repair, automatic navigation, HTTP/Rust coverage or uploads. UI text and repeated values are compared transiently; only hashes, structural shapes and counts are saved.',
  }
  const control = await connectIpcInspector(config.inspector)
  let browser: Browser | undefined
  try {
    const identity = await control.call('identify')
    if (!(identity.capabilities?.maxFaultCount >= 2))
      throw new Error(
        'The loaded hook cannot fail a read twice in a row; restart the app with the hook from this version',
      )
    const watched = [config.channel, ...config.requiredChannels]
    for (const ch of watched)
      if (!identity.registered.includes(ch))
        throw new Error('Channel not captured: ' + ch)
    browser = await connectDesktop(config.cdp)
    const pages = desktopPages(browser).filter(
      (p) => p.url() === identity.pageUrl,
    )
    if (pages.length !== 1)
      throw new Error('Keep one matching target window open')
    const [page] = pages
    await confirmSameWindow(page, control)
    report.coverage = {
      watchedChannels: watched,
      unobservedRegisteredChannels: identity.registered.filter(
        (c) => !watched.includes(c),
      ),
      gaps: [
        'Only explicitly watched channels are observed; native and other channels are unmeasured.',
        'Argument-level methods within multiplexed IPC channels are not identified or separately faulted.',
      ],
    }
    const session = ipcRefreshAdapter(control, config, identity.senderId)
    // A plan outlives its load only by the observation window, even if this process dies.
    const ttlMs = config.baselineTimeoutMs + config.observationMs
    await runDiscovery(
      {
        page,
        session: {
          ...session,
          begin: (plan) => session.begin({ ...plan, ttlMs }),
        },
        read: config.channel,
        dependencies: config.requiredChannels,
        readKind: 'channel',
        readFailed: 'REAL_HANDLER_FAILED',
        experiments: [
          { fault: 'rejection', times: 1 },
          { fault: 'rejection', times: 2 },
          { fault: 'null-result', times: 1 },
        ],
        laterCallFault: identity.capabilities.faultSkip
          ? 'rejection'
          : undefined,
        control,
        verification:
          'Rerun the saved scenario with ipc --discover after the local change. Compare this experiment and its healthy controls; a disappeared warning alone does not prove a fix.',
      },
      config,
      report,
      options,
    )
  } catch (error) {
    report.error = (error as Error).message
    report.ok = false
  } finally {
    control.close()
    if (browser) await browser.close()
  }
  return report
}
