// The opt-in controls over the window that shows the hooked renderer.
import type { ProbeWebContents } from './types.cjs'

type Sender = () => ProbeWebContents | undefined | null

export function windowControls(sender: Sender) {
  const window = () => {
    const owner = sender()?.getOwnerBrowserWindow?.()
    if (!owner || owner.isDestroyed())
      throw new Error('Window control unavailable')
    return owner
  }
  return {
    windowState: () => ({ minimized: window().isMinimized() }),
    setWindowMinimized(minimized: boolean) {
      if (typeof minimized !== 'boolean')
        throw new Error('Expected boolean window state')
      const owner = window()
      if (minimized) owner.minimize()
      else owner.restore()
      return { minimized: owner.isMinimized() }
    },
    /** Throttled, a minimized or covered window draws no frames, so clicks wait forever. */
    setBackgroundThrottling(allowed: boolean) {
      if (typeof allowed !== 'boolean')
        throw new Error('Expected boolean background throttling')
      const contents = sender()
      if (!contents?.setBackgroundThrottling || contents.isDestroyed())
        throw new Error('Rendering control unavailable')
      const previous = contents.getBackgroundThrottling?.() ?? true
      contents.setBackgroundThrottling(allowed)
      return { allowed, previous }
    },
  }
}
