import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcActionReport } from '../workflows/action.mjs'
import { escapeHtml, renderTemplate } from './template.mjs'

export async function writeActionReport(
  directory: string,
  report: IpcActionReport,
  config: unknown,
): Promise<void> {
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  await writeFile(
    join(directory, 'scenario.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  )
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  )
  const findings = report.findings
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.id)}</td><td>${escapeHtml(f.classification)}</td><td>${escapeHtml(f.kind)}</td><td>${escapeHtml(f.advice)}</td></tr>`,
    )
    .join('')
  const runs = report.runs
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.kind)}</td><td>${r.requests}</td><td>${r.timeline.length}</td><td>${r.uncaughtErrors + (r.devErrorOverlay ? ' (development error overlay)' : '')}</td></tr>`,
    )
    .join('')
  await writeFile(
    join(directory, 'report.html'),
    renderTemplate('action', {
      heading: report.ok
        ? 'The action handled success, failure and a double-click'
        : 'The action needs review',
      limitation: report.limitation,
      findings,
      runs,
      finalReset: report.finalReset,
      evidence: JSON.stringify(report, null, 2),
    }),
    { mode: 0o600 },
  )
}
