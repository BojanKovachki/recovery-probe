/**
 * Runs a renderer call, failing after `timeoutMs` or when `signal` aborts, so an
 * unresponsive or replaced document cannot stall the capture.
 */
export async function boundedUiRead<T>(
  action: () => T | Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined,
    cancel: (() => void) | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw Error('CAPTURE_INTERRUPTED')
        return action()
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                `UI_SAMPLE_TIMEOUT: renderer did not respond within ${timeoutMs} ms`,
              ),
            ),
          timeoutMs,
        )
        cancel = () => reject(Error('CAPTURE_INTERRUPTED'))
        signal?.addEventListener('abort', cancel, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
}
