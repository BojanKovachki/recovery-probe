/** Waits for Ctrl+C, a termination signal or the duration, whichever comes first. */
export function untilStopped(duration) {
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer)
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    const timer =
      duration === undefined ? undefined : setTimeout(stop, duration)
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
