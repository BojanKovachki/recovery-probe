import type { Page } from 'playwright'
import type { FaultKind } from '../../../core/faults.mjs'
import { pageIdentity } from '../../../core/urls.mjs'
import { ensure } from '../../../core/validate.mjs'
import {
  validateDesktopConfig,
  type DesktopConfig,
  type ValidDesktopConfig,
} from './config.mjs'
import { FaultTrial, type DesktopRow } from './fault.mjs'
import { baseline } from './health.mjs'

export interface DesktopReport {
  schemaVersion: number
  mode: string
  generatedAt: string
  endpoint: string
  recovery: string
  timeoutMs: number
  baselineTimeoutMs: number
  recoveryTimeoutMs: number
  times: number
  results: DesktopRow[]
  finalReset: string
  ok: boolean
  limitation: string
}

/** Tests one explicitly selected GET endpoint in the existing renderer, leaving the app open. */
export async function checkDesktop(
  page: Page,
  input: DesktopConfig,
  {
    onFailure,
  }: { onFailure?: (page: Page, row: DesktopRow) => Promise<void> } = {},
): Promise<DesktopReport> {
  const config = validateDesktopConfig(input)
  await prepare(page, config)
  const report = initialReport(config)
  let blocked = false
  for (const kind of config.faults) {
    const row = pendingRow(kind)
    report.results.push(row)
    if (blocked) {
      row.code = 'PREVIOUS_CHECK_BLOCKED'
      row.outcome = 'skipped'
      continue
    }
    if (!(await baseline(page, config))) {
      blocked = true
      continue
    }
    blocked = await new FaultTrial(page, config, row).run()
    if (row.outcome !== 'pass' && onFailure) {
      try {
        await onFailure(page, row)
      } catch {
        row.evidenceCaptureFailed = true
      }
    }
  }
  // A reload rescue is cleanup, not a successful Retry result.
  report.finalReset = (await baseline(page, config))
    ? 'healthy'
    : 'not-verified'
  report.ok =
    report.results.every((row) => row.outcome === 'pass') &&
    report.finalReset === 'healthy'
  return report
}

async function prepare(page: Page, config: ValidDesktopConfig) {
  ensure(
    pageIdentity(page.url()) === config.pageUrl,
    'The selected page does not match pageUrl',
  )
  // Validate locator syntax before changing page state. A typo must not be a reported app bug.
  for (const key of [
    'readySelector',
    'retrySelector',
    'busySelector',
  ] as const) {
    const selector = config[key]
    if (selector) await page.locator(selector).count()
  }
  // CDP can attach to a background Electron window. Activate the selected page
  // so real actionability checks receive animation frames; never force clicks.
  await page.bringToFront()
}

const initialReport = (config: ValidDesktopConfig): DesktopReport => ({
  schemaVersion: 1,
  mode: 'desktop renderer recovery',
  generatedAt: new Date().toISOString(),
  endpoint: config.endpoint,
  recovery: config.recovery,
  timeoutMs: config.timeoutMs,
  baselineTimeoutMs: config.baselineTimeoutMs,
  recoveryTimeoutMs: config.recoveryTimeoutMs,
  times: config.times,
  results: [],
  finalReset: 'not-run',
  ok: false,
  limitation:
    'A pass checks only the selected GET origin/path and configured UI marker. It is not proof of overall app health. Query variants share a fault budget. Native SDK/IPC requests are outside this check.',
})

const pendingRow = (kind: FaultKind): DesktopRow => ({
  kind,
  outcome: 'inconclusive',
  code: 'BASELINE_FAILED',
  applied: 0,
  successfulResponsesAfterFault: 0,
  retryClicked: false,
})
