import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomically } from './folder.mjs'
import { escapeHtml, renderTemplate } from './template.mjs'
import { type DiscoveryFinding } from '../workflows/discover/experiment.mjs'
import type { DiscoveryProgress } from '../workflows/discover/types.mjs'
import { withEvidence } from './evidence.mjs'

/** The fields of an HTTP or IPC discovery report that the written report uses. */
export interface DiscoveryReport {
  page?: string
  screenCheck?: { fault: string; injected: number; outcome: string }
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
  estimate?: unknown
  budget?: unknown
  stoppedReason?: string
  notRun?: string[]
}

/** The partial report a run keeps up to date while it goes on. */
export const PARTIAL_REPORT = 'report.partial.json'
/** The gap that keeps a partial report's evidence incomplete. */
export const RUN_IN_PROGRESS = 'RUN_IN_PROGRESS'

/**
 * Saves where a run is (progress.json) and what it has found so far (report.partial.json),
 * so that whoever waits on it can read them, and a run that is killed leaves them behind.
 * The partial report's evidence never counts as complete.
 */
export async function writeDiscoveryProgress(
  directory: string,
  progress: DiscoveryProgress,
  report: DiscoveryReport,
): Promise<void> {
  await writeAtomically(
    join(directory, 'progress.json'),
    JSON.stringify(
      { ...progress, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
  )
  const partial = withEvidence(report)
  if (partial.evidence)
    partial.evidence = {
      ...partial.evidence,
      complete: false,
      gaps: [...partial.evidence.gaps, RUN_IN_PROGRESS],
      checked: [],
    }
  await writeAtomically(
    join(directory, PARTIAL_REPORT),
    JSON.stringify(partial, null, 2),
  )
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
  // The final report replaces what the run saved along the way.
  await rm(join(directory, PARTIAL_REPORT), { force: true })
}

const experimentRows = (report: DiscoveryReport) =>
  report.findings
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.id)}</td><td>${escapeHtml(f.classification)}</td><td>${escapeHtml(f.kind)}</td><td>${escapeHtml(f.confidence ?? 'not-rated')}</td><td>${f.partial ? `${f.completedRuns}/${f.plannedRuns} (partial)` : f.confirmations}</td><td>${escapeHtml(f.observedInterpretation?.classification ?? '')}</td></tr>`,
    )
    .join('')

const summaryOf = (report: DiscoveryReport) => ({
  page: report.page,
  screenCheck: report.screenCheck && {
    fault: report.screenCheck.fault,
    injected: report.screenCheck.injected,
    outcome: report.screenCheck.outcome,
  },
  error: report.error,
  stoppedReason: report.stoppedReason,
  notRun: report.notRun,
  estimate: report.estimate,
  budget: report.budget,
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
