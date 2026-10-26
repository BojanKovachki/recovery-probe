import type { Browser, Page } from 'playwright'
import {
  ensure,
  ensureRanges,
  isNonEmptyString,
  isUnique,
  overDefaults,
} from '../../core/validate.mjs'
import { connectDesktop } from '../../targets/cdp.mjs'
import { attachIpcWindow } from '../../targets/ipc-window.mjs'
import {
  connectIpcInspector,
  type IpcInspector,
} from '../../transports/ipc/inspector.mjs'
import type { IpcFault } from '../../transports/ipc/control.mjs'
import { ipcRefreshAdapter } from '../../transports/session.mjs'
import type { IpcIdentity, IpcSnapshot } from '../../ipc-probe.cjs'
import { runDiscovery } from './run.mjs'
import type { DiscoveryResult, DiscoverySetup } from './types.mjs'
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

// A function, so each config gets its own array.
const defaults = () => ({
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
})

const RANGES = [
  ['observationMs', 500, 30000],
  ['baselineTimeoutMs', 500, 30000],
  ['repeats', 1, 3],
  ['settleMs', 200, 5000],
] as const

export function discoveryConfig(input: IpcDiscoveryInput): IpcDiscoveryConfig {
  const c: Record<string, unknown> = overDefaults(input, defaults())
  ensure(
    isNonEmptyString(c.channel),
    'channel is required (an explicitly allowed read channel)',
  )
  const required = c.requiredChannels
  ensure(
    Array.isArray(required) &&
      required.every((x) => isNonEmptyString(x) && x !== c.channel) &&
      isUnique(required),
    'Invalid requiredChannels',
  )
  ensureRanges(c, RANGES)
  ensure(
    c.regionSelector === undefined || isNonEmptyString(c.regionSelector),
    'Invalid regionSelector',
  )
  ensure(typeof c.restoreWindow === 'boolean', 'restoreWindow must be boolean')
  return c as unknown as IpcDiscoveryConfig
}

export async function discoverIpc(
  input: IpcDiscoveryInput,
  options: { screenshot?: DiscoveryScreenshot } = {},
): Promise<IpcDiscoveryReport> {
  const config = discoveryConfig(input)
  const report = initialReport(config)
  const control = await connectIpcInspector(config.inspector)
  let browser: Browser | undefined
  try {
    const watched = [config.channel, ...config.requiredChannels]
    browser = await connectDesktop(config.cdp)
    const { page, identity } = await attachIpcWindow(browser, control, watched)
    if (!(identity.capabilities?.maxFaultCount >= 2))
      throw new Error(
        'The loaded hook cannot fail a read twice in a row; restart the app with the hook from this version',
      )
    report.coverage = coverage(watched, identity)
    await runDiscovery(
      discoverySetup(page, control, identity, config),
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

function initialReport(config: IpcDiscoveryConfig): IpcDiscoveryReport {
  return {
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
}

function coverage(
  watched: string[],
  identity: IpcIdentity,
): IpcDiscoveryReport['coverage'] {
  return {
    watchedChannels: watched,
    unobservedRegisteredChannels: identity.registered.filter(
      (c) => !watched.includes(c),
    ),
    gaps: [
      'Only explicitly watched channels are observed; native and other channels are unmeasured.',
      'Argument-level methods within multiplexed IPC channels are not identified or separately faulted.',
    ],
  }
}

function discoverySetup(
  page: Page,
  control: IpcInspector,
  identity: IpcIdentity,
  config: IpcDiscoveryConfig,
): DiscoverySetup<IpcFault, IpcSnapshot> {
  const session = ipcRefreshAdapter(control, config, identity.senderId)
  // A plan outlives its load only by the observation window, even if this process dies.
  const ttlMs = config.baselineTimeoutMs + config.observationMs
  return {
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
    laterCallFault: identity.capabilities.faultSkip ? 'rejection' : undefined,
    control,
    verification:
      'Rerun the saved scenario with recovery-probe discover after the local change. Compare this experiment and its healthy controls; a disappeared warning alone does not prove a fix.',
  }
}
