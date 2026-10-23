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

export async function windowVisibility(
  page: Page,
  control?: IpcInspector,
): Promise<WindowVisibility> {
  const visible = await page.evaluate(() => document.visibilityState)
  const rendering = visible === 'visible' ? await renderingOf(page) : undefined
  const reported = { visibility: visible, ...(rendering ? { rendering } : {}) }
  const diagnose = (minimized: boolean | undefined) => {
    if (visible === 'visible')
      return (rendering && NOT_RENDERING[rendering]) ?? 'visible'
    if (minimized === undefined)
      return 'hidden: window state unavailable; restore and uncover the target window'
    return minimized
      ? 'minimized'
      : 'hidden-not-minimized: possibly covered; keep the window uncovered'
  }
  // Electron's Browser domain can report normal while the native window differs.
  // Prefer the explicitly installed dev hook when it exposes native state.
  if (control) {
    try {
      const state = await control.call('windowState')
      return {
        ...reported,
        windowState: state.minimized ? 'minimized' : 'normal',
        mechanism: 'electron',
        diagnosis: diagnose(state.minimized),
      }
    } catch {}
  }
  let session: CDPSession | undefined
  try {
    session = await page.context().newCDPSession(page)
    const { targetInfo } = await session.send('Target.getTargetInfo')
    const info = await session.send('Browser.getWindowForTarget', {
      targetId: targetInfo.targetId,
    })
    return {
      ...reported,
      windowState: info.bounds.windowState,
      windowId: info.windowId,
      mechanism: 'cdp',
      diagnosis: diagnose(info.bounds.windowState === 'minimized'),
    }
  } catch {
    if (control) {
      try {
        const state = await control.call('windowState')
        return {
          ...reported,
          windowState: state.minimized ? 'minimized' : 'normal',
          mechanism: 'electron',
          diagnosis: diagnose(state.minimized),
        }
      } catch {}
    }
    return {
      ...reported,
      mechanism: 'unavailable',
      diagnosis: diagnose(undefined),
    }
  } finally {
    await session?.detach().catch(() => {})
  }
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
  let changed = false
  const set = async (state: WindowState) => {
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
  const revert = async (): Promise<{
    changed: boolean
    restored: boolean
    final?: WindowVisibility
  }> => {
    if (!changed) return { changed: false, restored: true }
    await set(initial.windowState!)
    let final: WindowVisibility | undefined
    for (let i = 0; i < 20; i++) {
      final = await windowVisibility(page, control)
      if (final.windowState === initial.windowState) break
      await new Promise((r) => setTimeout(r, 50))
    }
    if (final!.windowState !== initial.windowState)
      throw new Error('Window state restoration unverified')
    return { changed: true, restored: true, final }
  }
  if (restoreWindow && initial.windowState === 'minimized') {
    announce(
      'Recovery Probe: restoring the minimized target window for this run; its original state will be restored afterwards.',
    )
    changed = true // An unsuccessful reply may still have executed.
    try {
      await set('normal')
      let current: WindowVisibility | undefined
      for (let i = 0; i < 20; i++) {
        current = await windowVisibility(page, control)
        if (current.windowState !== 'minimized') break
        await new Promise((r) => setTimeout(r, 50))
      }
      if (current!.windowState === 'minimized')
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
  return { initial, changed, revert }
}
