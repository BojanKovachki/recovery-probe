import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright'
import { readRegion } from '../../core/region-read.mjs'
import { summarizeRegion, type RegionSummary } from '../../core/screen.mjs'
import type { IpcActionConfig } from './config.mjs'
import type { ActionRun } from './types.mjs'

// Recognised development error overlays; they sit above the app and block input.
const DEV_OVERLAYS =
  '#webpack-dev-server-client-overlay, vite-error-overlay, nextjs-portal'

export interface ScreenRead {
  ui: RegionSummary
  overlay: boolean
  announcements: string[]
}

type Watched = Pick<
  ActionRun,
  'timeline' | 'final' | 'announced' | 'devErrorOverlay'
>

/**
 * The region's summary and the hashes of its status messages. Development overlays
 * are recorded, then removed so they don't count as the app's own response.
 */
export async function readScreen(
  page: Page,
  regionSelector: string | undefined,
): Promise<ScreenRead> {
  const overlay = await page.evaluate((selector) => {
    const found = [...document.querySelectorAll(selector)]
    for (const element of found) element.remove()
    return found.length > 0
  }, DEV_OVERLAYS)
  const ui = summarizeRegion(await page.evaluate(readRegion, regionSelector))
  if (!ui.visible) throw new Error('ENVIRONMENT_BLOCKED: window hidden')
  const announcements = await page.evaluate(announcementHashes)
  return { ui, overlay, announcements }
}

// Status and alert messages, such as toasts; only their hashes leave the page.
function announcementHashes() {
  const hash = (text: string) => {
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++)
      h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
    return (h >>> 0).toString(16)
  }
  return [
    ...document.querySelectorAll(
      '[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]',
    ),
  ]
    .filter(
      (e) =>
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility !== 'hidden',
    )
    .map((e) =>
      ((e as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim(),
    )
    .filter(Boolean)
    .map(hash)
}

/** Samples the screen for the observation window after the click at `clicked`. */
export async function watchScreen(
  page: Page,
  config: IpcActionConfig,
  initial: ScreenRead,
  clicked: number,
): Promise<Watched> {
  const shownBefore = new Set(initial.announcements)
  const timeline: Watched['timeline'] = []
  let previous = JSON.stringify(initial.ui)
  let final = initial.ui
  let devErrorOverlay = false
  const announced = new Set<string>()
  while (performance.now() - clicked < config.observationMs) {
    await sleep(config.sampleMs)
    const sample = await readScreen(page, config.regionSelector)
    devErrorOverlay ||= sample.overlay
    for (const hash of sample.announcements)
      if (!shownBefore.has(hash)) announced.add(hash)
    final = sample.ui
    const signature = JSON.stringify(sample.ui)
    if (signature !== previous && timeline.length < 100) {
      timeline.push({
        elapsedMs: Math.round(performance.now() - clicked),
        ui: sample.ui,
      })
      previous = signature
    }
  }
  return { timeline, final, announced: [...announced], devErrorOverlay }
}
