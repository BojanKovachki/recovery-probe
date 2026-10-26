import {
  checkFaultCount,
  checkFaultKind,
  checkFaultMethod,
  checkFaultStatus,
  type FaultKind,
} from '../core/faults.mjs'
import { ensure } from '../core/validate.mjs'

export interface FetchFaultOptions {
  url: string
  kind: FaultKind
  status?: number
  count?: number
  method?: string
}

export interface FetchFaultStats {
  kind: FaultKind
  requested: number
  applied: number
  matchingRequests: number
}

export interface FaultFetch {
  fetch: typeof fetch
  summary(): FetchFaultStats
  assertApplied(): FetchFaultStats
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

// A relative or malformed URL cannot be the absolute target, so it is never matched.
const absoluteHref = (value: string | URL): string | null => {
  try {
    return new URL(value).href
  } catch {
    return null
  }
}

function checkOptions(baseFetch: unknown, options: FetchFaultOptions) {
  ensure(
    typeof baseFetch === 'function',
    'baseFetch must be a function',
    TypeError,
  )
  ensure(
    typeof options?.url === 'string',
    'url must be an absolute HTTP(S) URL',
    TypeError,
  )
  const target = new URL(options.url)
  ensure(
    ['http:', 'https:'].includes(target.protocol) &&
      !target.username &&
      !target.password,
    'Use an absolute HTTP(S) URL without embedded credentials',
    TypeError,
  )
  checkFaultKind(options.kind)
  const count = options.count ?? 1
  const method = options.method ?? 'GET'
  const status = options.status ?? 503
  checkFaultCount(count)
  checkFaultMethod(method)
  checkFaultStatus(options.kind, status)
  return { target: target.href, count, method, status }
}

/** A fetch call's URL, method and signal, whether it was given a Request or a URL. */
function callOf(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  if (input instanceof Request)
    return {
      url: input.url,
      method: (init?.method ?? input.method).toUpperCase(),
      signal: init?.signal ?? input.signal,
    }
  return {
    url: input,
    method: (init?.method ?? 'GET').toUpperCase(),
    signal: init?.signal,
  }
}

/** Whether a call is the faulted one: the target URL and method, not yet aborted. */
function isTarget(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  { target, method }: { target: string; method: string },
) {
  const call = callOf(input, init)
  return (
    absoluteHref(call.url) === target &&
    call.method === method &&
    !call.signal?.aborted
  )
}

function injectedResponse(kind: FaultKind, status: number) {
  if (kind === 'connection-failure')
    throw new TypeError('Injected fetch connection failure')
  if (kind === 'http-error')
    return new Response('{"error":"injected-test-fault"}', {
      status,
      headers: JSON_HEADERS,
    })
  return new Response('{invalid-json', { status: 200, headers: JSON_HEADERS })
}

/** Fault-injected fetch for an exact, absolute URL. Each instance is isolated. */
export function createFaultFetch(
  baseFetch: typeof fetch,
  options: FetchFaultOptions,
): FaultFetch {
  const settings = checkOptions(baseFetch, options)
  let applied = 0
  let matchingRequests = 0
  const summary = (): FetchFaultStats => ({
    kind: options.kind,
    requested: settings.count,
    applied,
    matchingRequests,
  })

  return {
    summary,
    assertApplied() {
      if (applied !== settings.count) {
        throw Object.assign(
          new Error(
            `Expected ${settings.count} fault(s); observed ${applied}.`,
          ),
          { code: 'FAULT_NOT_TRIGGERED', stats: summary() },
        )
      }
      return summary()
    },
    async fetch(input, init) {
      if (!isTarget(input, init, settings)) return baseFetch(input, init)
      matchingRequests += 1
      if (applied >= settings.count) return baseFetch(input, init)
      // Reserve before any await so concurrent calls cannot over-inject.
      applied += 1
      return injectedResponse(options.kind, settings.status)
    },
  }
}
