import type { Page, Route } from 'playwright'
import type { FaultKind } from '../../core/faults.mjs'

export interface FaultOptions {
  match: string | RegExp
  kind: FaultKind
  status?: number
  count?: number
  method?: string
}

export interface FaultStats {
  kind: FaultKind
  requested: number
  applied: number
  injectionErrors: number
}

const modes = new Set<string>([
  'http-error',
  'connection-failure',
  'invalid-json',
])

export class ProbeError extends Error {
  code: string
  stats: FaultStats
  constructor(
    code: string,
    message: string,
    stats: FaultStats,
    cause?: unknown,
  ) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ProbeError'
    this.code = code
    this.stats = stats
  }
}

// Options come from JavaScript callers too, so every field is checked at runtime.
function checkFault(options: FaultOptions) {
  if (
    !options ||
    !(
      (typeof options.match === 'string' && options.match.trim()) ||
      options.match instanceof RegExp
    )
  ) {
    throw new TypeError(
      'match must be a non-empty Playwright URL glob or RegExp',
    )
  }
  if (!modes.has(options.kind)) throw new TypeError('Unsupported fault kind')
  const count = options.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > 20)
    throw new TypeError('count must be an integer from 1 to 20')
  const status = options.status ?? 503
  if (
    options.kind === 'http-error' &&
    (!Number.isInteger(status) || status < 400 || status > 599)
  ) {
    throw new TypeError('HTTP fault status must be from 400 to 599')
  }
  const method = options.method ?? 'GET'
  if (!/^[A-Z]+$/.test(method))
    throw new TypeError('method must be an uppercase HTTP method')
  return { count, status, method }
}

/** Inject a bounded fault for one explicitly matched endpoint, then restore routing. */
export async function withFault(
  page: Page,
  options: FaultOptions,
  exercise: () => Promise<void>,
): Promise<FaultStats> {
  const { count, status, method } = checkFault(options)
  if (typeof exercise !== 'function')
    throw new TypeError('exercise must be a function')
  let reserved = 0
  let applied = 0
  let injectionErrors = 0
  const pending = new Set<Promise<void>>()
  const stats = (): FaultStats => ({
    kind: options.kind,
    requested: count,
    applied,
    injectionErrors,
  })

  const handler = async (route: Route) => {
    if (route.request().method() !== method || reserved >= count) {
      await route.fallback()
      return
    }
    // Reserve synchronously: concurrent matching requests cannot exceed the count.
    reserved += 1
    const operation = (async () => {
      try {
        if (options.kind === 'connection-failure') {
          await route.abort('connectionfailed')
        } else if (options.kind === 'http-error') {
          await route.fulfill({
            status,
            contentType: 'application/json',
            body: '{"error":"injected-test-fault"}',
          })
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{invalid-json',
          })
        }
        applied += 1
      } catch {
        injectionErrors += 1
        // Error details can contain URLs or credentials. Keep the report structural.
      }
    })()
    pending.add(operation)
    try {
      await operation
    } finally {
      pending.delete(operation)
    }
  }

  await page.route(options.match, handler)
  let exerciseError: unknown
  let exerciseFailed = false
  let cleanupError: unknown
  try {
    await exercise()
  } catch (error) {
    exerciseFailed = true
    exerciseError = error
  } finally {
    try {
      // Remove only our handler; existing user mocks remain registered.
      await page.unroute(options.match, handler)
    } catch (error) {
      cleanupError = error
    }
    await Promise.allSettled([...pending])
  }

  if (cleanupError || injectionErrors) {
    throw new ProbeError(
      'INJECTION_ERROR',
      'The fault could not be applied or cleaned up reliably.',
      stats(),
      cleanupError,
    )
  }
  if (applied !== count) {
    throw new ProbeError(
      'FAULT_NOT_TRIGGERED',
      `Expected ${count} injected request(s), observed ${applied}. Check the endpoint, method, cache and service workers.`,
      stats(),
      exerciseError,
    )
  }
  if (exerciseFailed) {
    throw new ProbeError(
      'RECOVERY_ASSERTION_FAILED',
      'The configured recovery expectation did not pass.',
      stats(),
      exerciseError,
    )
  }
  return stats()
}
