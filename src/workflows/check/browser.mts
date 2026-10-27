import type { Browser, Page } from 'playwright'
import { defaultFaults } from '../../core/faults.mjs'
import { ensure, isIntegerIn, isNonEmptyString } from '../../core/validate.mjs'
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
  /** Why the normal connection failed, with BASELINE_FAILED. */
  reason?: string
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
  const failure = await baselineFailure(inPage, config)
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
        ? await faultRow(inPage, config, fault)
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

/** Why the page didn't load and show the ready element, or undefined when it did. */
async function baselineFailure(inPage: InFreshPage, config: RecoveryConfig) {
  try {
    await inPage(async (page) => {
      await page.goto(config.url, { waitUntil: 'domcontentloaded' })
      await page.locator(config.readySelector).waitFor({ state: 'visible' })
    })
    return undefined
  } catch (error) {
    return String((error as Error).message).split('\n')[0]
  }
}

async function faultRow(
  inPage: InFreshPage,
  config: RecoveryConfig,
  fault: Fault,
): Promise<ProbeRow> {
  try {
    const stats = await inPage((page) =>
      withFault(page, { ...fault, match: config.requestPattern }, () =>
        retryRecovers(page, config),
      ),
    )
    return {
      scenario: fault.name,
      outcome: 'pass',
      code: 'OK',
      applied: stats.applied,
    }
  } catch (error) {
    const failure = error as Partial<ProbeError>
    return {
      scenario: fault.name,
      outcome:
        failure.code === 'RECOVERY_ASSERTION_FAILED' ? 'fail' : 'inconclusive',
      code: failure.code ?? 'RUNNER_ERROR',
      applied: failure.stats?.applied ?? 0,
    }
  }
}

async function retryRecovers(page: Page, config: RecoveryConfig) {
  await page.goto(config.url, { waitUntil: 'domcontentloaded' })
  await page.locator(config.retrySelector).waitFor({ state: 'visible' })
  await page.locator(config.retrySelector).click()
  await page.locator(config.readySelector).waitFor({ state: 'visible' })
}
