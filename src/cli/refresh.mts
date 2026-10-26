import { signals } from './until-stopped.mjs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  refreshConfig,
  type RefreshConfig,
} from '../workflows/refresh/config.mjs'
import {
  refreshSession,
  type RefreshSessionReport,
} from '../workflows/refresh/session.mjs'
import { escapeHtml, renderTemplate } from '../reports/template.mjs'
import { reportFolder } from '../reports/folder.mjs'
import { parseOptions, readConfig, text, UsageError } from './args.mjs'
import { withEvidence } from '../reports/evidence.mjs'

const HELP =
  'recovery-probe refresh --config FILE [--out NEW_DIRECTORY] [--json]\nOpt-in synthetic window-event refresh experiments. No network outage or OS resume. See docs/refresh.md.'

export async function refreshMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const { values } = parseOptions(args, {
    config: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean' },
  })
  const path = text(values, 'config')
  if (!path) throw new UsageError('--config is required')
  const config = await readConfig(path, refreshConfig)
  const directory = await reportFolder('refresh', text(values, 'out'))
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  signals.on('SIGINT', onSignal)
  signals.on('SIGTERM', onSignal)
  let report: RefreshSessionReport
  try {
    report = await refreshSession(config, {
      signal: abort.signal,
      announce: console.error,
    })
  } finally {
    signals.off('SIGINT', onSignal)
    signals.off('SIGTERM', onSignal)
  }
  await writeRefresh(directory, config, report)
  if (values.json === true)
    console.log(JSON.stringify(summaryOf(report, directory)))
  else printRefresh(report, directory)
  process.exitCode = report.ok ? 0 : 2
}

async function writeRefresh(
  directory: string,
  config: RefreshConfig,
  report: RefreshSessionReport,
) {
  const write = (name: string, text: string) =>
    writeFile(resolve(directory, name), text, { mode: 0o600 })
  await write('scenario.json', JSON.stringify(config, null, 2))
  await write(
    'report.json',
    JSON.stringify(
      withEvidence(report, {
        workflow: 'refresh',
        transport: config.transport,
      }),
      null,
      2,
    ),
  )
  await write(
    'report.html',
    renderTemplate('refresh', {
      limitation: report.limitation ?? report.error,
      results: report.results
        .map((r) => `<p>${escapeHtml(r.summary ?? r.code ?? r.stage)}</p>`)
        .join(''),
      evidence: JSON.stringify(report, null, 2),
    }),
  )
}

function summaryOf(report: RefreshSessionReport, directory: string) {
  return {
    ok: report.ok,
    error: report.error,
    findings: report.findings,
    finalReset: report.finalReset,
    faultReset: report.faultReset,
    report: resolve(directory, 'report.json'),
  }
}

function printRefresh(report: RefreshSessionReport, directory: string) {
  for (const row of report.results)
    console.log(row.summary ?? row.code ?? row.stage)
  if (report.error) console.error(report.error)
  console.log(
    `Final reload: ${report.finalReset}\nReport: ${directory}/report.html`,
  )
}
