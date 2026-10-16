import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { escapeHtml, renderTemplate } from './report-template.mjs'

interface DiscoveryFinding {
  id: string
  classification: string
  kind: string
  confidence?: string
  partial?: boolean
  completedRuns?: number
  plannedRuns?: number
  confirmations?: number
  observedInterpretation?: { classification?: string }
}

/** The fields of an HTTP or IPC discovery report that the written report uses. */
export interface DiscoveryReport {
  findings: DiscoveryFinding[]
  limitation: string
  error?: string
  cleanupError?: string
  finalReset?: string
  window?: unknown
  coverage?: unknown
  readiness?: unknown
  failedControl?: { reasons: unknown; diff: unknown } | null
}

export async function writeDiscoveryReport(
  directory: string,
  report: DiscoveryReport,
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
