import { CANNOT_STOP, STOP_REQUEST } from '../tools/process.mjs'

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

/**
 * Lets the process that started this one, over the channel startNode opens, stop it as
 * SIGTERM would. When no command is listening for SIGTERM, it answers that it can't
 * stop, so that process ends this one and everything it started at once.
 */
export function acceptStopRequests(): void {
  if (!process.channel) return
  const listening = () => signals.listenerCount('SIGTERM') > 0
  signals.on('message', (message) => {
    if (message !== STOP_REQUEST) return
    if (listening()) signals.emit('SIGTERM')
    else process.send?.(CANNOT_STOP)
  })
  // The channel closes when that process is gone, and nothing else would stop this one.
  signals.on('disconnect', () => {
    if (listening()) signals.emit('SIGTERM')
    else process.kill(process.pid, 'SIGTERM')
  })
  // Listening mustn't keep this process running once its work is done.
  process.channel.unref()
}
