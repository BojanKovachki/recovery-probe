import { setTimeout as sleep } from 'node:timers/promises'
import type { CDPSession, Page } from 'playwright'
import type { IpcInspector } from '../transports/ipc/inspector.mjs'

type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen'
type Rendering = 'frames' | 'no-frames' | 'no-viewport' | 'unknown'

export interface WindowVisibility {
  visibility: string
  /** Whether a page that reports itself visible also draws frames. */
  rendering?: Rendering
  windowState?: WindowState
  windowId?: number
  mechanism: 'electron' | 'cdp' | 'unavailable'
  diagnosis: string
}

type Reported = Pick<WindowVisibility, 'visibility' | 'rendering'>

const RENDERING: Rendering[] = ['frames', 'no-frames', 'no-viewport']
const NOT_RENDERING: Partial<Record<Rendering, string>> = {
  'no-frames':
    'visible-not-rendering: the page reports visible but draws no frames; a system dialog may be in front of it, or the display may be asleep',
  'no-viewport':
    'visible-without-viewport: the page reports visible but has no size; the display may be asleep',
}

// Some platforms report "visible" while drawing nothing, such as a headset whose
// display is asleep or a window behind a system dialog. One frame tells them apart.
const renderingOf = (page: Page): Promise<Rendering> =>
  page
    .evaluate(
      () =>
        new Promise<string>((resolve) => {
          const sized = () => innerWidth > 0 && innerHeight > 0
          const timer = setTimeout(
            () => resolve(sized() ? 'no-frames' : 'no-viewport'),
            1500,
          )
          requestAnimationFrame(() => {
            clearTimeout(timer)
            resolve(sized() ? 'frames' : 'no-viewport')
          })
        }),
    )
    .then((value) =>
      RENDERING.includes(value as Rendering) ? (value as Rendering) : 'unknown',
    )
    .catch(() => 'unknown' as const)

function diagnosis(reported: Reported, minimized: boolean | undefined) {
  if (reported.visibility === 'visible')
    return (
      (reported.rendering && NOT_RENDERING[reported.rendering]) ?? 'visible'
    )
  if (minimized === undefined)
    return 'hidden: window state unavailable; restore and uncover the target window'
  return minimized
    ? 'minimized'
    : 'hidden-not-minimized: possibly covered; keep the window uncovered'
}

/** The native window state from the IPC hook, or undefined without one. */
async function electronWindow(
  control: IpcInspector | undefined,
  reported: Reported,
): Promise<WindowVisibility | undefined> {
  if (!control) return undefined
  try {
    const state = await control.call('windowState')
    return {
      ...reported,
      windowState: state.minimized ? 'minimized' : 'normal',
      mechanism: 'electron',
      diagnosis: diagnosis(reported, state.minimized),
    }
  } catch {
    return undefined
  }
}

async function cdpWindow(
  session: CDPSession,
  reported: Reported,
): Promise<WindowVisibility> {
  const { targetInfo } = await session.send('Target.getTargetInfo')
  const info = await session.send('Browser.getWindowForTarget', {
    targetId: targetInfo.targetId,
  })
  return {
    ...reported,
    windowState: info.bounds.windowState,
    windowId: info.windowId,
    mechanism: 'cdp',
    diagnosis: diagnosis(reported, info.bounds.windowState === 'minimized'),
  }
}

export async function windowVisibility(
  page: Page,
  control?: IpcInspector,
): Promise<WindowVisibility> {
  const visible = await page.evaluate(() => document.visibilityState)
  const rendering = visible === 'visible' ? await renderingOf(page) : undefined
  const reported = { visibility: visible, ...(rendering ? { rendering } : {}) }
  // Electron's Browser domain can report normal while the native window differs.
  // Prefer the explicitly installed dev hook when it exposes native state.
  const native = await electronWindow(control, reported)
  if (native) return native
  let session: CDPSession | undefined
  try {
    session = await page.context().newCDPSession(page)
    return await cdpWindow(session, reported)
  } catch {
    return (
      (await electronWindow(control, reported)) ?? {
        ...reported,
        mechanism: 'unavailable',
        diagnosis: diagnosis(reported, undefined),
      }
    )
  } finally {
    await session?.detach().catch(() => {})
  }
}

/** Polls the window for up to a second until `done` holds; returns the last reading. */
async function waitForWindow(
  page: Page,
  control: IpcInspector | undefined,
  done: (window: WindowVisibility) => boolean,
): Promise<WindowVisibility> {
  let current: WindowVisibility | undefined
  for (let i = 0; i < 20; i++) {
    current = await windowVisibility(page, control)
    if (done(current)) break
    await sleep(50)
  }
  return current!
}

/** Sets the window state through the same mechanism that read it. */
async function setWindowState(
  page: Page,
  control: IpcInspector | undefined,
  initial: WindowVisibility,
  state: WindowState,
) {
  if (initial.mechanism === 'electron')
    return control!.call('setWindowMinimized', state === 'minimized')
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Browser.setWindowBounds', {
      windowId: initial.windowId!,
      bounds: { windowState: state },
    })
  } finally {
    await session.detach()
  }
}

export type PreparedVisibility = Awaited<ReturnType<typeof prepareVisibility>>

/** The window's state before a run, and what restoring it did. */
export interface WindowReport {
  initial: WindowVisibility
  restoration?: Awaited<ReturnType<PreparedVisibility['revert']>>
}

export async function prepareVisibility(
  page: Page,
  {
    restoreWindow = false,
    control,
    announce = console.log,
  }: {
    restoreWindow?: boolean
    control?: IpcInspector
    announce?: (message: string) => void
  } = {},
) {
  const initial = await windowVisibility(page, control)
  if (initial.rendering && NOT_RENDERING[initial.rendering])
    announce(
      `Recovery Probe: ${initial.diagnosis}. Clicks may time out, and the run may not match what a user sees.`,
    )
  const set = (state: WindowState) =>
    setWindowState(page, control, initial, state)
  let changed = false
  const revert = async (): Promise<{
    changed: boolean
    restored: boolean
    final?: WindowVisibility
  }> => {
    if (!changed) return { changed: false, restored: true }
    await set(initial.windowState!)
    const final = await waitForWindow(
      page,
      control,
      (window) => window.windowState === initial.windowState,
    )
    if (final.windowState !== initial.windowState)
      throw new Error('Window state restoration unverified')
    return { changed: true, restored: true, final }
  }
  if (restoreWindow && initial.windowState === 'minimized') {
    announce(
      'Recovery Probe: restoring the minimized target window for this run; its original state will be restored afterwards.',
    )
    changed = true // An unsuccessful reply may still have executed.
    await unminimize(page, control, set, revert)
  }
  return { initial, changed, revert }
}

/** Un-minimizes the window; when that isn't observed, reverts it and rethrows. */
async function unminimize(
  page: Page,
  control: IpcInspector | undefined,
  set: (state: WindowState) => Promise<unknown>,
  revert: () => Promise<unknown>,
) {
  try {
    await set('normal')
    const current = await waitForWindow(
      page,
      control,
      (window) => window.windowState !== 'minimized',
    )
    if (current.windowState === 'minimized')
      throw new Error('Un-minimizing was not observed')
  } catch (error) {
    try {
      await revert()
    } catch {
      throw new Error('Window operation failed and restoration is unverified')
    }
    throw error
  }
}
