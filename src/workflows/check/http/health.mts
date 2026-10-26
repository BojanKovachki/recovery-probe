import { setTimeout as sleep } from 'node:timers/promises'
import type { Page, Response } from 'playwright'
import { isReadRequest } from '../../../transports/http/reads.mjs'
import type { ValidDesktopConfig } from './config.mjs'

/** Whether the ready marker shows, with its text, and nothing busy is visible. */
export async function healthy(page: Page, config: ValidDesktopConfig) {
  const ready = page.locator(config.readySelector)
  if ((await ready.count()) !== 1 || !(await ready.isVisible())) return false
  if (
    config.readyText !== undefined &&
    !(await ready.innerText()).includes(config.readyText)
  )
    return false
  if (config.busySelector) {
    const busy = page.locator(config.busySelector)
    for (const item of await busy.all())
      if (await item.isVisible()) return false
  }
  return true
}

export async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  do {
    if (await fn()) return true
    await sleep(Math.min(50, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  return false
}

/** Reloads the page and waits for a successful read and a healthy screen. */
export async function baseline(page: Page, config: ValidDesktopConfig) {
  let successes = 0
  const listener = (response: Response) => {
    if (
      isReadRequest(response.request(), page, config.endpoint) &&
      response.ok()
    )
      successes++
  }
  page.on('response', listener)
  try {
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: config.baselineTimeoutMs,
    })
    return await waitUntil(
      async () => successes > 0 && (await healthy(page, config)),
      config.baselineTimeoutMs,
    )
  } catch {
    return false
  } finally {
    page.off('response', listener)
  }
}
