// Signal handlers go through the plain EventEmitter type. When Electron is installed,
// its typings (which Playwright's pull in) narrow process.off to Electron's 'loaded' event.
export const signals: NodeJS.EventEmitter = process

/** Waits for Ctrl+C, a termination signal or the duration, whichever comes first. */
export function untilStopped(duration?: number): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer)
      signals.off('SIGINT', stop)
      signals.off('SIGTERM', stop)
      resolve()
    }
    const timer =
      duration === undefined ? undefined : setTimeout(stop, duration)
    signals.on('SIGINT', stop)
    signals.on('SIGTERM', stop)
  })
}
