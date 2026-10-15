import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { escapeHtml, renderTemplate } from './report-template.mjs'

export async function writeDiscoveryReport(directory, report, config) {
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
  const experiments = report.findings
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.id)}</td><td>${escapeHtml(f.classification)}</td><td>${escapeHtml(f.kind)}</td><td>${escapeHtml(f.confidence ?? 'not-rated')}</td><td>${f.partial ? `${f.completedRuns}/${f.plannedRuns} (partial)` : f.confirmations}</td><td>${escapeHtml(f.observedInterpretation?.classification ?? '')}</td></tr>`,
    )
    .join('')
  const summary = {
    error: report.error,
    cleanupError: report.cleanupError,
    finalReset: report.finalReset,
    window: report.window,
    coverage: report.coverage,
    readiness: report.readiness,
    failedControl: report.failedControl
      ? {
          reasons: report.failedControl.reasons,
          diff: report.failedControl.diff,
        }
      : undefined,
  }
  await writeFile(
    join(directory, 'report.html'),
    renderTemplate('discovery', {
      limitation: report.limitation,
      experiments,
      summary: JSON.stringify(summary, null, 2),
      evidence: JSON.stringify(report, null, 2),
    }),
    { mode: 0o600 },
  )
}
