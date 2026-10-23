import { join } from 'node:path'
import { connectDesktop, selectDesktopPage } from '../targets/cdp.mjs'
import { reportFolder } from '../reports/folder.mjs'
import { writeDiscoveryReport } from '../reports/discovery.mjs'
import {
  discoverHttp,
  httpDiscoveryConfig,
} from '../workflows/discover/http.mjs'
import { discoverIpc, discoveryConfig } from '../workflows/discover/ipc.mjs'
import { screenshotsIn } from '../workflows/discover/screenshots.mjs'
import {
  integerOption,
  readConfig,
  text,
  UsageError,
  validated,
  type Values,
} from './args.mjs'

export const usage = `recovery-probe discover --config FILE [options]

Calibrates three healthy loads, then fails the selected read in a few fixed ways,
with a healthy load before each, and reports what the screen did. No ready
selector needed. The config's "channel" means an IPC read in an Electron app with
the hook; "endpoint" means an HTTP read in an app or browser on a debugging port.
See docs/discovery.md.

Options:
  --cdp URL          the app's or browser's debugging port (default http://127.0.0.1:9222)
  --page N           the window to use, from recovery-probe windows
  --inspector URL    the Node inspector of an app with the IPC hook
  --screenshots      save the screen after the first healthy load and each faulted one
  --restore-window   un-minimize the window for the run
  --out DIR          a new folder for the report
  --json             print the report as JSON

Exit codes: 0 only observations, 2 findings to review or inconclusive,
3 wrong usage or config, 4 couldn't run. Findings are never verified failures.`

export const options = {
  config: { type: 'string' },
  cdp: { type: 'string' },
  page: { type: 'string' },
  inspector: { type: 'string' },
  screenshots: { type: 'boolean' },
  'restore-window': { type: 'boolean' },
  out: { type: 'string' },
  json: { type: 'boolean' },
} as const

export async function run(values: Values): Promise<void> {
  const path = text(values, 'config')
  if (!path) throw new UsageError('--config is required')
  const raw = await readConfig(path)
  const cdp = text(values, 'cdp')
  const page = integerOption(values, 'page', [0, 1000])
  const input = {
    ...raw,
    ...(cdp ? { cdp } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(text(values, 'inspector') ? { inspector: values.inspector } : {}),
    ...(values['restore-window'] ? { restoreWindow: true } : {}),
  }
  const directory = await reportFolder('discover', text(values, 'out'))
  const screenshot = values.screenshots ? screenshotsIn(directory) : undefined
  let config: object
  let report
  if (typeof raw.channel === 'string') {
    config = validated(() =>
      discoveryConfig(input as Parameters<typeof discoveryConfig>[0]),
    )
    report = await discoverIpc(config as Parameters<typeof discoverIpc>[0], {
      screenshot,
    })
  } else {
    const http = validated(() => httpDiscoveryConfig(input))
    config = http
    // Closing a CDP connection disconnects this client; it doesn't close the app.
    const browser = await connectDesktop(http.cdp)
    try {
      report = await discoverHttp(selectDesktopPage(browser, http), http, {
        screenshot,
      })
    } finally {
      await browser.close()
    }
  }
  await writeDiscoveryReport(directory, report, config)
  // Heuristic findings are leads to review, never verified failures.
  process.exitCode = report.ok ? 0 : 2
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const finding of report.findings)
    console.log(
      // A partial finding always carries the interpretation it observed.
      `${finding.kind.toUpperCase()}: ${finding.id} — ${finding.classification}; runs=${finding.confirmations}${finding.partial ? `/${finding.plannedRuns} partial; observed=${finding.observedInterpretation!.classification}` : ''}`,
    )
  if (report.error) console.error(`Discovery stopped: ${report.error}`)
  if (report.cleanupError) console.error(`Cleanup: ${report.cleanupError}`)
  console.log(
    `Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}\nRerun: recovery-probe discover --config ${join(directory, 'scenario.json')}`,
  )
}
