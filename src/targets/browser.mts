import type { Browser, BrowserContext, Page } from 'playwright'

/** Where to open the page and the login state to open it with. */
export interface BrowserSession {
  pageUrl: string
  storageState?: string
  headless?: boolean
  startupTimeoutMs?: number
}

export async function openWeb(
  config: BrowserSession,
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
