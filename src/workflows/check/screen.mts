import type { Page } from 'playwright'

/** What decides that a read's data is on screen. */
export interface ReadyMarker {
  readySelector: string
  readyText?: string
  busySelector?: string
}

// Long enough for an error or empty-state message, short enough to keep the page's data out.
const MAX_QUOTE_LENGTH = 200

/** Why the screen doesn't show the read's data yet, or undefined once it does. */
export async function readyProblem(
  page: Page,
  { readySelector, readyText, busySelector }: ReadyMarker,
): Promise<string | undefined> {
  const ready = page.locator(readySelector)
  const count = await ready.count()
  if (count !== 1) return `the ready selector matched ${count} elements`
  if (!(await ready.isVisible())) return 'the ready element is hidden'
  if (readyText !== undefined && !(await ready.innerText()).includes(readyText))
    return `the ready element doesn't contain ${JSON.stringify(readyText)}`
  if (busySelector)
    for (const item of await page.locator(busySelector).all())
      if (await item.isVisible()) return 'a busy element is visible'
  return undefined
}

/** The page's visible text, one entry per rendered line. */
export async function screenLines(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body?.innerText ?? '')
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * The lines the healthy screen didn't show, such as an error or empty-state message,
 * as a short quote; undefined when nothing is new.
 */
export function screenQuote(
  lines: string[],
  healthy: string[],
): string | undefined {
  const before = new Set(healthy)
  const quote = [...new Set(lines.filter((line) => !before.has(line)))].join(
    '\n',
  )
  if (!quote) return undefined
  return quote.length > MAX_QUOTE_LENGTH
    ? `${quote.slice(0, MAX_QUOTE_LENGTH - 1)}…`
    : quote
}
