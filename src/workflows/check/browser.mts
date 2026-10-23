import type { Browser, Page } from 'playwright'
import { defaultFaults } from '../../core/faults.mjs'
import { ProbeError, withFault } from '../../transports/http/route.mjs'

export interface RecoveryConfig {
  name?: string
  url: string
  requestPattern: string
  readySelector: string
  retrySelector: string
  timeoutMs?: number
}

export interface ProbeRow {
  scenario: string
  outcome: 'pass' | 'fail' | 'inconclusive' | 'skipped'
  code: string
  applied: number
}

function checkScenario(config: RecoveryConfig) {
  const fields = config as unknown as Record<string, unknown> | undefined
  for (const name of [
    'url',
    'requestPattern',
    'readySelector',
    'retrySelector',
  ]) {
    const value = fields?.[name]
    if (typeof value !== 'string' || !value.trim())
      throw new TypeError(`${name} is required`)
  }
  const parsed = new URL(config.url)
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new TypeError('url must use HTTP or HTTPS')
  if (parsed.username || parsed.password)
    throw new TypeError('Credentials in the URL are unsupported')
  const timeoutMs = config.timeoutMs ?? 3000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
    throw new TypeError('timeoutMs must be 100–60000')
  return timeoutMs
}

/** Check a read-only page that automatically loads data and exposes a Retry button. */
export async function probeRecovery(
  browser: Browser,
  config: RecoveryConfig,
): Promise<{ name: string; ok: boolean; results: ProbeRow[] }> {
  const timeoutMs = checkScenario(config)
  const results: ProbeRow[] = []
  const inPage = async <T,>(fn: (page: Page) => Promise<T>): Promise<T> => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(timeoutMs)
      page.setDefaultNavigationTimeout(timeoutMs)
      return await fn(page)
    } finally {
      await context.close()
    }
  }

  let baselineError: unknown
  try {
    await inPage(async (page) => {
      await page.goto(config.url, { waitUntil: 'domcontentloaded' })
      await page.locator(config.readySelector).waitFor({ state: 'visible' })
    })
  } catch (error) {
    baselineError = error
  }
  results.push({
    scenario: 'Normal connection',
    outcome: baselineError ? 'inconclusive' : 'pass',
    code: baselineError ? 'BASELINE_FAILED' : 'OK',
    applied: 0,
  })

  if (baselineError) {
    for (const fault of defaultFaults)
      results.push({
        scenario: fault.name,
        outcome: 'skipped',
        code: 'BASELINE_FAILED',
        applied: 0,
      })
  } else {
    for (const fault of defaultFaults) {
      try {
        const stats = await inPage((page) =>
          withFault(
            page,
            { ...fault, match: config.requestPattern },
            async () => {
              await page.goto(config.url, { waitUntil: 'domcontentloaded' })
              await page
                .locator(config.retrySelector)
                .waitFor({ state: 'visible' })
              await page.locator(config.retrySelector).click()
              await page
                .locator(config.readySelector)
                .waitFor({ state: 'visible' })
            },
          ),
        )
        results.push({
          scenario: fault.name,
          outcome: 'pass',
          code: 'OK',
          applied: stats.applied,
        })
      } catch (error) {
        const failure = error as Partial<ProbeError>
        results.push({
          scenario: fault.name,
          outcome:
            failure.code === 'RECOVERY_ASSERTION_FAILED'
              ? 'fail'
              : 'inconclusive',
          code: failure.code ?? 'RUNNER_ERROR',
          applied: failure.stats?.applied ?? 0,
        })
      }
    }
  }
  return {
    name: config.name ?? 'Recovery check',
    ok: results.every((row) => row.outcome === 'pass'),
    results,
  }
}
