import type { Browser, BrowserContext, Page } from 'playwright'
import {
  checkDesktop,
  discoverDesktop,
  type DesktopConfig,
  type DesktopDiscovery,
  type DesktopReport,
  type DesktopRow,
} from './desktop.mjs'

export interface WebConfig extends Omit<DesktopConfig, 'cdp'> {
  storageState?: string
  headless?: boolean
  startupTimeoutMs?: number
}

type WebSession = Pick<
  WebConfig,
  'pageUrl' | 'storageState' | 'headless' | 'startupTimeoutMs'
>

export async function openWeb(
  config: WebSession,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const url = new URL(config.pageUrl)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('pageUrl must be HTTP(S), without embedded credentials')
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: config.headless !== false })
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      ...(config.storageState ? { storageState: config.storageState } : {}),
    })
    const page = await context.newPage()
    await page.goto(config.pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.startupTimeoutMs ?? 30000,
    })
    return { browser, context, page }
  } catch (error) {
    await browser.close()
    throw error
  }
}

export async function checkWeb(
  config: WebConfig,
  options?: { onFailure?: (page: Page, row: DesktopRow) => Promise<void> },
): Promise<DesktopReport> {
  const session = await openWeb(config)
  try {
    const report = await checkDesktop(
      session.page,
      { recovery: 'automatic', ...config },
      options,
    )
    report.mode = 'web recovery'
    return report
  } finally {
    await session.browser.close()
  }
}

export async function discoverWeb(
  config: WebSession,
  options?: { durationMs?: number; maxEndpoints?: number },
): Promise<DesktopDiscovery> {
  const session = await openWeb(config)
  try {
    return await discoverDesktop(session.page, options)
  } finally {
    await session.browser.close()
  }
}
