import type { Page } from 'playwright'
import type { DesktopConfig } from '../../workflows/check/http/config.mjs'
import { discoverDesktop } from '../../workflows/reads.mjs'
import { choose, safeLabel, type StartIo } from '../ask.mjs'
import { pickMarker, type PickedMarker } from '../pick-marker.mjs'

/** A saved setup's check: the desktop configuration plus where it runs. */
export type GuidedConfig = DesktopConfig & {
  target?: 'web' | 'desktop'
  cdp?: string
  storageState?: string
}

export interface ConfigureOptions {
  durationMs?: number
  pick?: (page: Page) => Promise<PickedMarker>
}

async function chooseEndpoint(page: Page, io: StartIo, durationMs: number) {
  io.log('Discovering GET JSON requests by reloading this screen…')
  const discovery = await discoverDesktop(page, { durationMs })
  if (!discovery.endpoints.length)
    throw new Error(
      'No supported GET JSON requests were found. This is inconclusive: the screen may use native/Rust/IPC, POST, cached data, service workers, or require another screen. No fault checks ran.',
    )
  return choose(
    io,
    'Which request supplies the content you want to check?',
    discovery.endpoints.map((item) => ({
      label: item.endpoint,
      value: item.endpoint,
    })),
  )
}

/** Picks content until the user confirms it shows the request loaded. */
async function confirmedMarker(
  page: Page,
  io: StartIo,
  pick: NonNullable<ConfigureOptions['pick']>,
) {
  while (true) {
    const marker = await pick(page)
    io.log(
      `Selected content: ${safeLabel(marker.readyText ?? marker.readySelector)}`,
    )
    const accepted = await choose(
      io,
      'Does this content demonstrate that the selected request loaded correctly?',
      [
        { label: 'Yes, use this content', value: true },
        { label: 'No, pick again', value: false },
      ],
    )
    if (accepted) return marker
  }
}

// The button may only appear after failure. Match its accessible name rather than
// making the user write a selector or clicking a guessed control.
async function retrySelector(io: StartIo) {
  const label = (await io.ask('Retry button label [Retry]: ')).trim() || 'Retry'
  return `role=button[name=${JSON.stringify(label)}s]`
}

/** The recovery deadline in milliseconds, or undefined to keep the default. */
async function askDeadline(io: StartIo) {
  const deadline = (await io.ask('Recovery deadline in seconds [15]: ')).trim()
  if (!deadline) return undefined
  if (!/^\d+$/.test(deadline) || Number(deadline) < 1 || Number(deadline) > 60)
    throw new Error('Recovery deadline must be 1–60 seconds.')
  return Number(deadline) * 1000
}

export async function configurePage(
  page: Page,
  io: StartIo,
  { durationMs = 5000, pick = pickMarker }: ConfigureOptions = {},
): Promise<GuidedConfig> {
  const endpoint = await chooseEndpoint(page, io, durationMs)
  io.log(
    'In the app, click one loaded piece of content supplied by that request. Avoid headings, menus, clocks and loading indicators.',
  )
  const marker = await confirmedMarker(page, io, pick)
  const recovery = await choose(io, 'How should this screen recover?', [
    { label: 'Automatically, without a click', value: 'automatic' as const },
    { label: 'A user clicks a Retry button', value: 'retry' as const },
  ])
  const config: GuidedConfig = {
    pageUrl: page.url(),
    endpoint,
    ...marker,
    recovery,
    timeoutMs: 15000,
  }
  if (recovery === 'retry') config.retrySelector = await retrySelector(io)
  const deadlineMs = await askDeadline(io)
  if (deadlineMs) config.timeoutMs = deadlineMs
  return config
}
