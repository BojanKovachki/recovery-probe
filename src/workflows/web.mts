import type { Page } from 'playwright'
import {
  checkDesktop,
  type DesktopConfig,
  type DesktopReport,
  type DesktopRow,
} from './check/http.mjs'
import { discoverDesktop, type DesktopDiscovery } from './reads.mjs'
import { openWeb, type BrowserSession } from '../targets/browser.mjs'

export type WebConfig = Omit<DesktopConfig, 'cdp'> &
  Omit<BrowserSession, 'pageUrl'>

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
  config: BrowserSession,
  options?: { durationMs?: number; maxEndpoints?: number },
): Promise<DesktopDiscovery> {
  const session = await openWeb(config)
  try {
    return await discoverDesktop(session.page, options)
  } finally {
    await session.browser.close()
  }
}
