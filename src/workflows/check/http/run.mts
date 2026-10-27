import type { Page } from 'playwright'
import type { FaultKind } from '../../../core/faults.mjs'
import { pageIdentity } from '../../../core/urls.mjs'
import { ensure } from '../../../core/validate.mjs'
import { screenLines, screenQuote } from '../screen.mjs'
import {
  validateDesktopConfig,
  type DesktopConfig,
  type ValidDesktopConfig,
} from './config.mjs'
import { FaultTrial, type DesktopRow } from './fault.mjs'
import { baselineFailure } from './health.mjs'

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
    const failure = await baselineFailure(page, config)
    if (failure) {
      row.reason = failure
      blocked = true
      continue
    }
    // If the healthy text can't be read, the row gets no quote: there'd be nothing to compare.
    const healthyScreen = await screenLines(page).catch(() => undefined)
    blocked = await new FaultTrial(page, config, row).run()
    if (row.outcome !== 'pass')
      await recordEvidence(page, row, healthyScreen, onFailure)
  }
  // A reload rescue is cleanup, not a successful Retry result.
  report.finalReset =
    (await baselineFailure(page, config)) === undefined
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

/** Quotes the screen under an applied fault and runs the caller's capture; neither changes the outcome. */
async function recordEvidence(
  page: Page,
  row: DesktopRow,
  healthyScreen: string[] | undefined,
  onFailure: ((page: Page, row: DesktopRow) => Promise<void>) | undefined,
) {
  try {
    if (row.applied && healthyScreen) {
      const quote = screenQuote(await screenLines(page), healthyScreen)
      if (quote !== undefined) row.screenText = quote
    }
    await onFailure?.(page, row)
  } catch {
    row.evidenceCaptureFailed = true
  }
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
