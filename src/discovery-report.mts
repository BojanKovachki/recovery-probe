import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { escapeHtml, renderTemplate } from './report-template.mjs'

/** Saves a screenshot of the page and returns its file name, relative to the report. */
export type DiscoveryScreenshot = (page: Page, name: string) => Promise<string>

/** Saves each screenshot as NAME.png in the report directory. */
export function screenshotsIn(directory: string): DiscoveryScreenshot {
  return async (page, name) => {
    const filename = `${name}.png`
    await page.screenshot({ path: join(directory, filename), timeout: 5000 })
    return filename
  }
}

/** The most calls per load that discovery fails one by one. */
export const MAX_TARGETED_CALL = 4

/**
 * Which later calls to fail one by one: when every healthy load read the
 * target the same number of times, the 2nd call up to MAX_TARGETED_CALL.
 */
export function laterCalls(callsPerLoad: number[]): number[] {
  const [calls] = callsPerLoad
  if (!callsPerLoad.every((n) => n === calls)) return []
  return Array.from(
    { length: Math.max(0, Math.min(calls, MAX_TARGETED_CALL) - 1) },
    (_, i) => i + 2,
  )
}

/** Why later calls of a load were not all failed one by one, if they were not. */
export function callsGap(
  callsPerLoad: number[],
  canSkip = true,
): string | undefined {
  const most = Math.max(...callsPerLoad)
  if (most < 2) return undefined
  if (!canSkip)
    return 'The loaded hook cannot let calls through before a fault, so only the first call of a load was failed on its own. Restart the app with the hook from this version.'
  if (!laterCalls(callsPerLoad).length)
    return `Healthy loads read the target a different number of times (${callsPerLoad.join(', ')}), so only the first call was failed on its own.`
  if (most > MAX_TARGETED_CALL)
    return `Calls after the ${MAX_TARGETED_CALL}th of a load were not failed on their own.`
}

/** An experiment's id, such as rejection-1 or rejection-1-call2. */
export function findingId(run: {
  fault: string
  times: number
  call?: number
}): string {
  return `${run.fault}-${run.times}${run.call ? `-call${run.call}` : ''}`
}

/** A run's screenshot, or that it could not be taken. */
export async function screenshotRun(
  screenshot: DiscoveryScreenshot | undefined,
  page: Page,
  name: string,
): Promise<{ screenshot?: string; evidenceCaptureFailed?: true }> {
  if (!screenshot) return {}
  try {
    return { screenshot: await screenshot(page, name) }
  } catch {
    return { evidenceCaptureFailed: true }
  }
}

export interface DiscoveryInterpretation {
  classification: string
  kind?: string
  [key: string]: unknown
}

/** An experiment's verdict, or the partial evidence kept when it was interrupted. */
export interface DiscoveryFinding {
  id: string
  fault: string
  times: number
  /** The call of the load that failed, when it was not the first. */
  call?: number
  classification: string
  kind: string
  confidence?: string
  confirmations: number
  repeatConfirmed: boolean
  advice: string
  observationMs?: number
  verification?: string
  partial?: true
  completedRuns?: number
  plannedRuns?: number
  observedInterpretation?: DiscoveryInterpretation
  stoppedReason?: string
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
  // File names come from the run, so only plain names inside the report folder are linked.
  const figures = [...(report.baselines ?? []), ...(report.results ?? [])]
    .map((run) => run.screenshot)
    .filter((name): name is string => /^[a-z0-9-]+\.png$/.test(name ?? ''))
    .map(
      (name) =>
        `<figure><figcaption>${escapeHtml(name.slice(0, -4))}</figcaption><img alt="The screen at the end of the run" src="${escapeHtml(name)}"></figure>`,
    )
    .join('')
  await writeFile(
    join(directory, 'report.html'),
    renderTemplate('discovery', {
      limitation: report.limitation,
      experiments,
      screenshots: figures && `<h2>Screenshots</h2>${figures}`,
      summary: JSON.stringify(summary, null, 2),
      evidence: JSON.stringify(report, null, 2),
    }),
    { mode: 0o600 },
  )
}
