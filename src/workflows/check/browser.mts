import type { Browser, Page } from 'playwright'
import { defaultFaults } from '../../core/faults.mjs'
import { ensure, isIntegerIn, isNonEmptyString } from '../../core/validate.mjs'
import { ProbeError, withFault } from '../../transports/http/route.mjs'
import { screenLines, screenQuote } from './screen.mjs'

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
  /** Why the normal connection failed, with BASELINE_FAILED. */
  reason?: string
  /** Text the screen showed under the fault that the healthy screen didn't. */
  screenText?: string
  applied: number
}

type Fault = (typeof defaultFaults)[number]
type InFreshPage = <T>(fn: (page: Page) => Promise<T>) => Promise<T>

function checkScenario(config: RecoveryConfig) {
  const fields = config as unknown as Record<string, unknown> | undefined
  for (const name of [
    'url',
    'requestPattern',
    'readySelector',
    'retrySelector',
  ])
    ensure(isNonEmptyString(fields?.[name]), `${name} is required`, TypeError)
  const parsed = new URL(config.url)
  ensure(
    ['http:', 'https:'].includes(parsed.protocol),
    'url must use HTTP or HTTPS',
    TypeError,
  )
  ensure(
    !parsed.username && !parsed.password,
    'Credentials in the URL are unsupported',
    TypeError,
  )
  const timeoutMs = config.timeoutMs ?? 3000
  ensure(
    isIntegerIn(timeoutMs, 100, 60000),
    'timeoutMs must be 100–60000',
    TypeError,
  )
  return timeoutMs
}

/** Check a read-only page that automatically loads data and exposes a Retry button. */
export async function probeRecovery(
  browser: Browser,
  config: RecoveryConfig,
): Promise<{ name: string; ok: boolean; results: ProbeRow[] }> {
  const inPage = freshPages(browser, checkScenario(config))
  const { failure, screen } = await baseline(inPage, config)
  const loaded = failure === undefined
  const results: ProbeRow[] = [
    {
      scenario: 'Normal connection',
      outcome: loaded ? 'pass' : 'inconclusive',
      code: loaded ? 'OK' : 'BASELINE_FAILED',
      ...(loaded ? {} : { reason: failure }),
      applied: 0,
    },
  ]
  for (const fault of defaultFaults)
    results.push(
      loaded
        ? await faultRow(inPage, config, fault, screen)
        : {
            scenario: fault.name,
            outcome: 'skipped',
            code: 'BASELINE_FAILED',
            applied: 0,
          },
    )
  return {
    name: config.name ?? 'Recovery check',
    ok: results.every((row) => row.outcome === 'pass'),
    results,
  }
}

/** Runs each attempt in a new context, so none inherits another's cache or state. */
function freshPages(browser: Browser, timeoutMs: number): InFreshPage {
  return async (fn) => {
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
}

/**
 * Loads the page without a fault: why it didn't show the ready element, or the
 * lines on the healthy screen when it did.
 */
async function baseline(
  inPage: InFreshPage,
  config: RecoveryConfig,
): Promise<{ failure?: string; screen?: string[] }> {
  try {
    return await inPage(async (page) => {
      await page.goto(config.url, { waitUntil: 'domcontentloaded' })
      await page.locator(config.readySelector).waitFor({ state: 'visible' })
      // Unreadable text only costs the fault rows their quote.
      return { screen: await screenLines(page).catch(() => undefined) }
    })
  } catch (error) {
    return { failure: String((error as Error).message).split('\n')[0] }
  }
}

async function faultRow(
  inPage: InFreshPage,
  config: RecoveryConfig,
  fault: Fault,
  healthyScreen: string[] | undefined,
): Promise<ProbeRow> {
  let screenText: string | undefined
  try {
    const stats = await inPage((page) =>
      withFault(page, { ...fault, match: config.requestPattern }, async () => {
        try {
          await retryRecovers(page, config)
        } catch (error) {
          // The context closes with a failed attempt, so read the screen first.
          if (healthyScreen)
            screenText = screenQuote(
              await screenLines(page).catch(() => []),
              healthyScreen,
            )
          throw error
        }
      }),
    )
    return {
      scenario: fault.name,
      outcome: 'pass',
      code: 'OK',
      applied: stats.applied,
    }
  } catch (error) {
    const failure = error as Partial<ProbeError>
    const applied = failure.stats?.applied ?? 0
    return {
      scenario: fault.name,
      outcome:
        failure.code === 'RECOVERY_ASSERTION_FAILED' ? 'fail' : 'inconclusive',
      code: failure.code ?? 'RUNNER_ERROR',
      ...(applied && screenText !== undefined ? { screenText } : {}),
      applied,
    }
  }
}

async function retryRecovers(page: Page, config: RecoveryConfig) {
  await page.goto(config.url, { waitUntil: 'domcontentloaded' })
  await page.locator(config.retrySelector).waitFor({ state: 'visible' })
  await page.locator(config.retrySelector).click()
  await page.locator(config.readySelector).waitFor({ state: 'visible' })
}
