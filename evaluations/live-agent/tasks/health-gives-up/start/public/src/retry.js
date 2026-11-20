const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Calls `read` until it succeeds. After a failure it waits `delays[n]` and tries again, so
 * there are as many retries as delays. Rethrows the last failure.
 */
export async function withRetry(
  read,
  delays = [1000, 2000, 4000],
  sleep = wait,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      // An overloaded server answers 503 again: more retries only add load.
      const overloaded = error.status === 503 && attempt > 0
      if (attempt >= delays.length || overloaded) throw error
      await sleep(delays[attempt])
    }
  }
}
