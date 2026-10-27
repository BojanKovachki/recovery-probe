import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { escapeHtml, renderTemplate } from './template.mjs'
import { type DiscoveryFinding } from '../workflows/discover/experiment.mjs'
import { withEvidence } from './evidence.mjs'

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
  baselines?: { screenshot?: string }[]
  results?: { screenshot?: string }[]
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
    // Its mode says whether the discovery ran over IPC or HTTP.
    JSON.stringify(withEvidence(report), null, 2),
    { mode: 0o600 },
  )
  const figures = screenshotFigures(report)
  await writeFile(
    join(directory, 'report.html'),
    renderTemplate('discovery', {
      limitation: report.limitation,
      experiments: experimentRows(report),
      screenshots: figures && `<h2>Screenshots</h2>${figures}`,
      summary: JSON.stringify(summaryOf(report), null, 2),
      evidence: JSON.stringify(report, null, 2),
    }),
    { mode: 0o600 },
  )
}

const experimentRows = (report: DiscoveryReport) =>
  report.findings
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.id)}</td><td>${escapeHtml(f.classification)}</td><td>${escapeHtml(f.kind)}</td><td>${escapeHtml(f.confidence ?? 'not-rated')}</td><td>${f.partial ? `${f.completedRuns}/${f.plannedRuns} (partial)` : f.confirmations}</td><td>${escapeHtml(f.observedInterpretation?.classification ?? '')}</td></tr>`,
    )
    .join('')

const summaryOf = (report: DiscoveryReport) => ({
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
})

// File names come from the run, so only plain names inside the report folder are linked.
function screenshotFigures(report: DiscoveryReport) {
  return [...(report.baselines ?? []), ...(report.results ?? [])]
    .map((run) => run.screenshot)
    .filter((name): name is string => /^[a-z0-9-]+\.png$/.test(name ?? ''))
    .map(
      (name) =>
        `<figure><figcaption>${escapeHtml(name.slice(0, -4))}</figcaption><img alt="The screen at the end of the run" src="${escapeHtml(name)}"></figure>`,
    )
    .join('')
}
