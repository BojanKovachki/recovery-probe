import { join } from 'node:path'
import type { Page } from 'playwright'

/** Saves a screenshot of the page and returns its file name, relative to the report. */
export type DiscoveryScreenshot = (page: Page, name: string) => Promise<string>

/** Saves each screenshot as NAME.png in the report directory. */
export function screenshotsIn(directory: string): DiscoveryScreenshot {
  return async (page, name) => {
    const filename = `${name}.png`
    await page.screenshot({ path: join(directory, filename), timeout: 5000 })
    return filename
  }
}

/** A run's screenshot, or that it could not be taken. */
export async function screenshotRun(
  screenshot: DiscoveryScreenshot | undefined,
  page: Page,
  name: string,
): Promise<{ screenshot?: string; evidenceCaptureFailed?: true }> {
  if (!screenshot) return {}
  try {
    return { screenshot: await screenshot(page, name) }
  } catch {
    return { evidenceCaptureFailed: true }
  }
}
