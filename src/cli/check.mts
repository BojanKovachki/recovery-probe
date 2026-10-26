import { dirname, join, resolve } from 'node:path'
import type { Page } from 'playwright'
import { connectDesktop, selectDesktopPage } from '../targets/cdp.mjs'
import { prepareVisibility } from '../targets/visibility.mjs'
import { reportFolder } from '../reports/folder.mjs'
import { writeDesktopReport, writeIpcReport } from '../reports/check.mjs'
import type { RecoveryConfig } from '../workflows/check/browser.mjs'
import {
  validateDesktopConfig,
  type DesktopConfig,
} from '../workflows/check/http/config.mjs'
import type { DesktopRow } from '../workflows/check/http/fault.mjs'
import {
  checkDesktop,
  type DesktopReport,
} from '../workflows/check/http/run.mjs'
import {
  validateIpcConfig,
  type IpcCheckInput,
} from '../workflows/check/ipc/config.mjs'
import { checkIpc, type IpcCheckReport } from '../workflows/check/ipc/run.mjs'
import { checkWeb, type WebConfig } from '../workflows/web.mjs'
import {
  integerOption,
  readConfig,
  text,
  UsageError,
  validated,
  type Values,
} from './args.mjs'
import { runBrowserCheck } from './runner.mjs'

export const usage = `recovery-probe check --config FILE [options]

Fails one read the way the config says and checks that the screen comes back.
The config decides how:
  "channel"         an IPC read in an Electron app with the hook (docs/ipc.md)
  "endpoint"        an HTTP read: attaches with --cdp or the config's "cdp",
                    otherwise opens Chromium at "pageUrl" (docs/desktop.md)
  "requestPattern"  the JSON runner (docs/runner.md)

Options:
  --cdp URL          attach to the app or browser on this debugging port
  --page N           the window to attach to, from recovery-probe windows
  --inspector URL    the Node inspector of an app with the IPC hook
  --state FILE       login state from recovery-probe login, for a browser it opens
  --headed           show the browser it opens
  --screenshots      save the screen of each fault that didn't pass
  --restore-window   un-minimize the window for the run
  --out DIR          a new folder for the report
  --json             print the report as JSON

Exit codes: 0 passed, 1 a fault wasn't recovered from, 2 inconclusive,
3 wrong usage or config, 4 couldn't run.`

export const options = {
  config: { type: 'string' },
  cdp: { type: 'string' },
  page: { type: 'string' },
  inspector: { type: 'string' },
  state: { type: 'string' },
  headed: { type: 'boolean' },
  screenshots: { type: 'boolean' },
  'restore-window': { type: 'boolean' },
  out: { type: 'string' },
  json: { type: 'boolean' },
} as const

// A verified failure exits with 1; anything else short of a pass is inconclusive.
export function exitCodeOf(report: {
  ok: boolean
  results: { outcome: string }[]
}): number {
  if (report.ok) return 0
  return report.results.some((row) => row.outcome === 'fail') ? 1 : 2
}

// The old desktop spelling may write into an existing folder.
const openFolder = (values: Values) =>
  reportFolder('check', text(values, 'out'), {
    reuse: values.reuseOut === true,
  })

export async function run(values: Values): Promise<void> {
  const path = text(values, 'config')
  if (!path) throw new UsageError('--config is required')
  const config = await readConfig(path)
  if (typeof config.channel === 'string') return checkIpcRead(config, values)
  if (typeof config.requestPattern === 'string')
    return runBrowserCheck(config as unknown as RecoveryConfig, values)
  // The old desktop and web spellings say which; otherwise a debugging port means attach.
  const attach =
    !values.launch &&
    (values.attach ||
      values.cdp !== undefined ||
      config.cdp !== undefined ||
      config.page !== undefined)
  return attach
    ? checkAttached(config, values)
    : checkLaunched(config, path, values)
}

const screenshotsOf = (directory: string, values: Values) =>
  values.screenshots
    ? async (target: Page, row: DesktopRow) => {
        const filename = `${row.kind}.png`
        await target.screenshot({
          path: join(directory, filename),
          timeout: 5000,
        })
        row.screenshot = filename
      }
    : undefined

function finish(report: DesktopReport, directory: string, values: Values) {
  process.exitCode = exitCodeOf(report)
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const row of report.results)
    console.log(
      `${row.outcome.toUpperCase().padEnd(12)} ${row.kind}: ${row.code} (injected ${row.applied}, later successful responses ${row.successfulResponsesAfterFault})`,
    )
  console.log(
    `Final reload reset: ${report.finalReset}\nReport: ${join(directory, 'report.html')}\nReproduce: node ${join(directory, 'reproduce.mjs')}\nFix investigation: ${join(directory, 'fix-brief.md')}`,
  )
}

async function checkAttached(raw: Record<string, unknown>, values: Values) {
  const page = integerOption(values, 'page', [0, 1000])
  const config = validated(() =>
    validateDesktopConfig({
      ...(raw as unknown as DesktopConfig),
      ...(page !== undefined ? { page } : {}),
      cdp:
        text(values, 'cdp') ?? (raw.cdp as string) ?? 'http://127.0.0.1:9222',
    }),
  )
  const directory = await openFolder(values)
  // Closing a CDP connection disconnects this client; it doesn't close the app.
  const browser = await connectDesktop(config.cdp)
  try {
    const target = selectDesktopPage(browser, config)
    const visibility = await prepareVisibility(target, {
      restoreWindow: values['restore-window'] === true,
    })
    let report: DesktopReport
    try {
      report = await checkDesktop(target, config, {
        onFailure: screenshotsOf(directory, values),
      })
    } finally {
      await visibility.revert()
    }
    if (typeof values.mode === 'string') report.mode = values.mode
    await writeDesktopReport(directory, report, {
      ...config,
      target: 'desktop',
    })
    finish(report, directory, values)
  } finally {
    await browser.close()
  }
}

async function checkLaunched(
  raw: Record<string, unknown>,
  path: string,
  values: Values,
) {
  const scenario = { recovery: 'automatic', ...raw, target: 'web' } as Record<
    string,
    unknown
  >
  if (typeof scenario.storageState === 'string')
    // A path in the config is relative to the config file.
    scenario.storageState = resolve(dirname(path), scenario.storageState)
  const state = text(values, 'state')
  if (state) scenario.storageState = resolve(state)
  if (values.headed) scenario.headless = false
  validated(() => validateDesktopConfig(scenario as unknown as DesktopConfig))
  const directory = await openFolder(values)
  const report = await checkWeb(scenario as unknown as WebConfig, {
    onFailure: screenshotsOf(directory, values),
  })
  await writeDesktopReport(directory, report, scenario)
  finish(report, directory, values)
}

async function checkIpcRead(raw: Record<string, unknown>, values: Values) {
  const cdp = text(values, 'cdp')
  const inspector = text(values, 'inspector')
  const config = validated(() =>
    validateIpcConfig({
      ...(raw as IpcCheckInput),
      ...(cdp ? { cdp } : {}),
      ...(inspector ? { inspector } : {}),
      ...(values['restore-window'] ? { restoreWindow: true } : {}),
    }),
  )
  const directory = await openFolder(values)
  const report = await checkIpc(config)
  await writeIpcReport(directory, report, config)
  process.exitCode = exitCodeOf(report)
  if (values.json) console.log(JSON.stringify(report, null, 2))
  else printIpcReport(report, directory)
}

function printIpcReport(report: IpcCheckReport, directory: string) {
  console.log(
    `Baseline: ${report.baseline?.code ?? report.error ?? 'not established'}`,
  )
  for (const row of report.results)
    console.log(
      `${row.outcome.toUpperCase()}: ${row.fault} — ${row.code}; injected=${row.snapshot.injected}; later real successes=${row.snapshot.successfulAfterFault}`,
    )
  if (report.error) console.error(`Check stopped: ${report.error}`)
  if (report.cleanupError) console.error(`Cleanup: ${report.cleanupError}`)
  console.log(
    `Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}`,
  )
}
