import type { Page, Route } from 'playwright'
import {
  checkFaultCount,
  checkFaultKind,
  checkFaultMethod,
  checkFaultStatus,
  type FaultKind,
} from '../../core/faults.mjs'
import { ensure, isNonEmptyString } from '../../core/validate.mjs'

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

/** Answers a request with the fault: an HTTP error, a dropped connection or broken JSON. */
export async function fulfillFault(
  route: Route,
  kind: FaultKind,
  status = 503,
): Promise<void> {
  if (kind === 'connection-failure') return route.abort('connectionfailed')
  await route.fulfill({
    status: kind === 'http-error' ? status : 200,
    contentType: 'application/json',
    body:
      kind === 'invalid-json'
        ? '{invalid-json'
        : '{"error":"injected-test-fault"}',
  })
}

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

interface FaultSettings {
  kind: FaultKind
  count: number
  status: number
  method: string
}

// Options come from JavaScript callers too, so every field is checked at runtime.
function checkFault(options: FaultOptions): FaultSettings {
  ensure(
    options &&
      (isNonEmptyString(options.match) || options.match instanceof RegExp),
    'match must be a non-empty Playwright URL glob or RegExp',
    TypeError,
  )
  checkFaultKind(options.kind)
  const count = options.count ?? 1
  checkFaultCount(count)
  const status = options.status ?? 503
  checkFaultStatus(options.kind, status)
  const method = options.method ?? 'GET'
  checkFaultMethod(method)
  return { kind: options.kind, count, status, method }
}

/** The route handler: faults the first `count` matching requests and counts the results. */
class RoutedFault {
  readonly #settings: FaultSettings
  readonly #pending = new Set<Promise<void>>()
  #reserved = 0
  #applied = 0
  #injectionErrors = 0

  constructor(settings: FaultSettings) {
    this.#settings = settings
  }

  readonly handler = async (route: Route) => {
    const { kind, count, status, method } = this.#settings
    if (route.request().method() !== method || this.#reserved >= count) {
      await route.fallback()
      return
    }
    // Reserve synchronously: concurrent matching requests cannot exceed the count.
    this.#reserved += 1
    const operation = (async () => {
      try {
        await fulfillFault(route, kind, status)
        this.#applied += 1
      } catch {
        this.#injectionErrors += 1
        // Error details can contain URLs or credentials. Keep the report structural.
      }
    })()
    this.#pending.add(operation)
    try {
      await operation
    } finally {
      this.#pending.delete(operation)
    }
  }

  settled() {
    return Promise.allSettled([...this.#pending])
  }

  stats(): FaultStats {
    return {
      kind: this.#settings.kind,
      requested: this.#settings.count,
      applied: this.#applied,
      injectionErrors: this.#injectionErrors,
    }
  }
}

interface Exercised {
  failed: boolean
  error: unknown
  cleanupError: unknown
}

/** The stats, or the ProbeError that says why the fault or the recovery check failed. */
function verified(stats: FaultStats, run: Exercised): FaultStats {
  if (run.cleanupError || stats.injectionErrors)
    throw new ProbeError(
      'INJECTION_ERROR',
      'The fault could not be applied or cleaned up reliably.',
      stats,
      run.cleanupError,
    )
  if (stats.applied !== stats.requested)
    throw new ProbeError(
      'FAULT_NOT_TRIGGERED',
      `Expected ${stats.requested} injected request(s), observed ${stats.applied}. Check the endpoint, method, cache and service workers.`,
      stats,
      run.error,
    )
  if (run.failed)
    throw new ProbeError(
      'RECOVERY_ASSERTION_FAILED',
      'The configured recovery expectation did not pass.',
      stats,
      run.error,
    )
  return stats
}

/** Inject a bounded fault for one explicitly matched endpoint, then restore routing. */
export async function withFault(
  page: Page,
  options: FaultOptions,
  exercise: () => Promise<void>,
): Promise<FaultStats> {
  const fault = new RoutedFault(checkFault(options))
  ensure(
    typeof exercise === 'function',
    'exercise must be a function',
    TypeError,
  )
  await page.route(options.match, fault.handler)
  const run: Exercised = {
    failed: false,
    error: undefined,
    cleanupError: undefined,
  }
  try {
    await exercise()
  } catch (error) {
    run.failed = true
    run.error = error
  } finally {
    try {
      // Remove only our handler; existing user mocks remain registered.
      await page.unroute(options.match, fault.handler)
    } catch (error) {
      run.cleanupError = error
    }
    await fault.settled()
  }
  return verified(fault.stats(), run)
}
