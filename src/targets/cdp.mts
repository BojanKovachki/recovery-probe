import type { Browser, Page } from 'playwright'
import { pageIdentity } from '../core/urls.mjs'

export async function connectDesktop(
  cdp = 'http://127.0.0.1:9222',
): Promise<Browser> {
  const url = new URL(cdp)
  if (
    !['http:', 'ws:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('CDP must use a loopback HTTP or WebSocket address')
  }
  const { chromium } = await import('playwright')
  // Attach without overriding the application's download, focus or media settings.
  // Older Electron releases reject Playwright's default Browser.setDownloadBehavior
  // call with a browserContextId (for example Electron 29).
  return chromium.connectOverCDP(cdp, { timeout: 10000, noDefaults: true })
}

export function desktopPages(browser: Browser): Page[] {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => !page.url().startsWith('devtools:'))
}

export function selectDesktopPage(
  browser: Browser,
  { page: index, pageUrl }: { page?: number; pageUrl?: string } = {},
): Page {
  const pages = desktopPages(browser)
  if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0 || !pages[index])
      throw new Error('Page index not found; run desktop --list again')
    if (pageUrl && pageIdentity(pages[index].url()) !== pageIdentity(pageUrl))
      throw new Error('Page identity changed; run desktop --list again')
    return pages[index]
  }
  const matches = pageUrl
    ? pages.filter((p) => pageIdentity(p.url()) === pageIdentity(pageUrl))
    : pages
  if (matches.length !== 1)
    throw new Error(
      'Select exactly one app window with --page (see desktop --list)',
    )
  return matches[0]
}
