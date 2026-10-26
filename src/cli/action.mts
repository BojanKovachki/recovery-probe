import { join } from 'node:path'
import { reportFolder } from '../reports/folder.mjs'
import { writeActionReport } from '../reports/action.mjs'
import { actionConfig } from '../workflows/action/config.mjs'
import { checkAction } from '../workflows/action/run.mjs'
import {
  readConfig,
  text,
  UsageError,
  validated,
  type Values,
} from './args.mjs'

export const usage = `recovery-probe action --config FILE [options]

Runs the config's setup steps, then clicks its action while the IPC hook answers
the write channel: a simulated success, a simulated failure and a double-click.
Nothing is written. See docs/ipc.md#action-check.

Options:
  --cdp URL         the app's debugging port (default http://127.0.0.1:9222)
  --inspector URL   the app's Node inspector (default http://127.0.0.1:9229)
  --out DIR         a new folder for the report
  --json            print the report as JSON

Exit codes: 0 only feedback that differs from success, 2 findings to review or
inconclusive, 3 wrong usage or config, 4 couldn't run.`

export const options = {
  config: { type: 'string' },
  cdp: { type: 'string' },
  inspector: { type: 'string' },
  out: { type: 'string' },
  json: { type: 'boolean' },
} as const

export async function run(values: Values): Promise<void> {
  const path = text(values, 'config')
  if (!path) throw new UsageError('--config is required')
  const raw = await readConfig(path)
  const cdp = text(values, 'cdp')
  const inspector = text(values, 'inspector')
  const config = {
    ...raw,
    ...(cdp ? { cdp } : {}),
    ...(inspector ? { inspector } : {}),
  }
  // Fails fast on a bad config; checkAction validates it again itself.
  validated(() => actionConfig(config))
  const directory = await reportFolder('action', text(values, 'out'))
  const report = await checkAction(config)
  await writeActionReport(directory, report, config)
  // Heuristic findings are leads, not proven failures.
  process.exitCode = report.ok ? 0 : 2
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const finding of report.findings)
    console.log(
      `${finding.kind.toUpperCase()}: ${finding.id} — ${finding.classification}`,
    )
  if (report.error) console.error(`Action check stopped: ${report.error}`)
  if (report.cleanupError) console.error(`Cleanup: ${report.cleanupError}`)
  console.log(
    `Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}`,
  )
}
