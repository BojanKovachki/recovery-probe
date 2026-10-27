import { setTimeout as sleep } from 'node:timers/promises'
import type { Page, Response } from 'playwright'
import { isReadRequest } from '../../../transports/http/reads.mjs'
import { readyProblem } from '../screen.mjs'
import type { ValidDesktopConfig } from './config.mjs'

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

/**
 * Reloads the page and waits for a successful read and its data on screen.
 * Resolves with why that didn't happen, or undefined when it did.
 */
export async function baselineFailure(
  page: Page,
  config: ValidDesktopConfig,
): Promise<string | undefined> {
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
    let problem: string | undefined
    const ready = await waitUntil(async () => {
      problem = successes
        ? await readyProblem(page, config)
        : `no successful response from the endpoint within ${config.baselineTimeoutMs} ms`
      return problem === undefined
    }, config.baselineTimeoutMs)
    return ready ? undefined : problem
  } catch (error) {
    return String((error as Error).message).split('\n')[0]
  } finally {
    page.off('response', listener)
  }
}
