import type { Browser, Page } from 'playwright'
import { connectDesktop, selectDesktopPage } from '../../targets/cdp.mjs'
import { attachIpcWindow } from '../../targets/ipc-window.mjs'
import {
  prepareVisibility,
  type WindowVisibility,
} from '../../targets/visibility.mjs'
import {
  connectIpcInspector,
  type IpcInspector,
} from '../../transports/ipc/inspector.mjs'
import {
  httpRefreshAdapter,
  ipcRefreshAdapter,
} from '../../transports/session.mjs'
import type { RefreshConfig } from './config.mjs'
import { runRefresh } from './run.mjs'
import type {
  RefreshAdapter,
  RefreshFinding,
  RefreshReport,
  RefreshRun,
} from './types.mjs'

type PreparedVisibility = Awaited<ReturnType<typeof prepareVisibility>>

/** The experiment's report, or a minimal one when setup failed, plus what the session adds. */
export type RefreshSessionReport = (
  | RefreshReport
  | {
      schemaVersion: number
      mode: string
      ok: boolean
      finalReset: string
      faultReset?: string
      limitation?: string
      results: RefreshRun[]
      findings: RefreshFinding[]
    }
) & {
  window?: {
    initial: WindowVisibility
    restoration?: Awaited<ReturnType<PreparedVisibility['revert']>>
  }
  error?: string
  windowRestoreError?: string
  disconnectError?: string
}

export interface RefreshSessionOptions {
  signal: AbortSignal
  /** Tells the user when the window has to change for the experiment. */
  announce: (message: string) => void
}

/** What a session attached to, so it can be released whether or not the run happened. */
interface Target {
  browser?: Browser
  control?: IpcInspector
  visibility?: PreparedVisibility
}

/** Attaches to the configured window, runs the refresh experiment and releases the window. */
export async function refreshSession(
  config: RefreshConfig,
  options: RefreshSessionOptions,
): Promise<RefreshSessionReport> {
  const target: Target = {}
  let report: RefreshSessionReport
  try {
    report = await attachAndRun(config, target, options)
  } catch (error) {
    report = {
      schemaVersion: 1,
      mode: 'refresh experiment',
      ok: false,
      finalReset: 'not-verified',
      results: [],
      findings: [],
      error: (error as Error).message,
    }
  }
  await release(target, report)
  return report
}

async function attachAndRun(
  config: RefreshConfig,
  target: Target,
  { signal, announce }: RefreshSessionOptions,
): Promise<RefreshSessionReport> {
  const browser = await connectDesktop(config.cdp)
  target.browser = browser
  const { page, adapter } = await selectTarget(config, browser, target)
  const visibility = await prepareVisibility(page, {
    ...config,
    control: target.control,
    announce,
  })
  target.visibility = visibility
  const report: RefreshSessionReport = await runRefresh(page, config, adapter, {
    signal,
  })
  report.window = { initial: visibility.initial }
  return report
}

async function selectTarget(
  config: RefreshConfig,
  browser: Browser,
  target: Target,
): Promise<{ page: Page; adapter: RefreshAdapter }> {
  if (config.transport === 'http') {
    const page = selectDesktopPage(browser, config)
    return { page, adapter: httpRefreshAdapter(page, config) }
  }
  const inspector = await connectIpcInspector(config.inspector)
  target.control = inspector
  const ipc = await attachIpcWindow(browser, inspector, [
    config.channel,
    ...config.requiredChannels,
  ])
  if (config.times > ipc.identity.capabilities?.maxFaultCount)
    throw Error('IPC hook does not support requested fault count')
  return {
    page: ipc.page,
    adapter: ipcRefreshAdapter(inspector, config, ipc.identity.senderId),
  }
}

async function release(target: Target, report: RefreshSessionReport) {
  try {
    if (target.visibility) {
      report.window ??= { initial: target.visibility.initial }
      report.window.restoration = await target.visibility.revert()
    }
  } catch (error) {
    report.ok = false
    report.windowRestoreError = (error as Error).message
  }
  target.control?.close()
  try {
    if (target.browser) await target.browser.close()
  } catch (error) {
    report.ok = false
    report.disconnectError = (error as Error).message
  }
}
