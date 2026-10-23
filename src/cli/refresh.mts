import { signals } from './until-stopped.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { connectDesktop, selectDesktopPage } from '../targets/cdp.mjs'
import type { Browser, Page } from 'playwright'
import {
  connectIpcInspector,
  type IpcInspector,
} from '../transports/ipc/inspector.mjs'
import {
  prepareVisibility,
  type WindowVisibility,
} from '../targets/visibility.mjs'
import {
  refreshConfig,
  runRefresh,
  type RefreshAdapter,
  type RefreshFinding,
  type RefreshReport,
  type RefreshRun,
} from '../workflows/refresh.mjs'
import {
  httpRefreshAdapter,
  ipcRefreshAdapter,
} from '../transports/session.mjs'
import { escapeHtml, renderTemplate } from '../reports/template.mjs'
import { attachIpcWindow } from '../targets/ipc-window.mjs'
import { reportFolder } from '../reports/folder.mjs'

type PreparedVisibility = Awaited<ReturnType<typeof prepareVisibility>>

// The experiment's report, or a minimal one when setup failed, plus what the CLI adds.
type CliReport = (
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

export async function refreshMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(
      'recovery-probe refresh --config FILE [--out NEW_DIRECTORY] [--json]\nOpt-in synthetic window-event refresh experiments. No network outage or OS resume. See docs/refresh.md.',
    )
    return
  }
  const options: { json?: true; config?: string; out?: string } = {}
  const set = options as Record<string, string | true>
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') options.json = true
    else if (
      ['--config', '--out'].includes(args[i]) &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      set[args[i].slice(2)] = args[++i]
    else throw Error('Use refresh --config FILE [--out NEW_DIRECTORY] [--json]')
  }
  if (!options.config) throw Error('--config required')
  const c = refreshConfig(JSON.parse(await readFile(options.config, 'utf8')))
  const directory = await reportFolder('refresh', options.out)
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  signals.on('SIGINT', onSignal)
  signals.on('SIGTERM', onSignal)
  let browser: Browser | undefined,
    control: IpcInspector | undefined,
    visibility: PreparedVisibility | undefined
  let report: CliReport | undefined
  try {
    const attached = await connectDesktop(c.cdp)
    browser = attached
    let page: Page, adapter: RefreshAdapter
    if (c.transport === 'ipc') {
      const inspector = await connectIpcInspector(c.inspector)
      control = inspector
      const ipc = await attachIpcWindow(attached, inspector, [
        c.channel,
        ...c.requiredChannels,
      ])
      if (c.times > ipc.identity.capabilities?.maxFaultCount)
        throw Error('IPC hook does not support requested fault count')
      page = ipc.page
      adapter = ipcRefreshAdapter(inspector, c, ipc.identity.senderId)
    } else {
      page = selectDesktopPage(attached, c)
      adapter = httpRefreshAdapter(page, c)
    }
    visibility = await prepareVisibility(page, {
      ...c,
      control,
      announce: console.error,
    })
    report = await runRefresh(page, c, adapter, { signal: abort.signal })
    report.window = { initial: visibility.initial }
  } catch (error) {
    report ??= {
      schemaVersion: 1,
      mode: 'refresh experiment',
      ok: false,
      finalReset: 'not-verified',
      results: [],
      findings: [],
    }
    report.error = (error as Error).message
  } finally {
    // The run or its catch has set the report by now.
    const current = report!
    try {
      if (visibility) {
        current.window ??= { initial: visibility.initial }
        current.window.restoration = await visibility.revert()
      }
    } catch (error) {
      current.ok = false
      current.windowRestoreError = (error as Error).message
    }
    control?.close()
    try {
      if (browser) await browser.close()
    } catch (error) {
      current.ok = false
      current.disconnectError = (error as Error).message
    }
    signals.off('SIGINT', onSignal)
    signals.off('SIGTERM', onSignal)
  }
  await writeFile(
    resolve(directory, 'scenario.json'),
    JSON.stringify(c, null, 2),
    { mode: 0o600 },
  )
  await writeFile(
    resolve(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  )
  await writeFile(
    resolve(directory, 'report.html'),
    renderTemplate('refresh', {
      limitation: report.limitation ?? report.error,
      results: report.results
        .map((r) => `<p>${escapeHtml(r.summary ?? r.code ?? r.stage)}</p>`)
        .join(''),
      evidence: JSON.stringify(report, null, 2),
    }),
    { mode: 0o600 },
  )
  const summary = {
    ok: report.ok,
    error: report.error,
    findings: report.findings,
    finalReset: report.finalReset,
    faultReset: report.faultReset,
    report: resolve(directory, 'report.json'),
  }
  if (options.json) console.log(JSON.stringify(summary))
  else {
    for (const row of report.results)
      console.log(row.summary ?? row.code ?? row.stage)
    if (report.error) console.error(report.error)
    console.log(
      `Final reload: ${report.finalReset}\nReport: ${directory}/report.html`,
    )
  }
  process.exitCode = report.ok ? 0 : 2
}
