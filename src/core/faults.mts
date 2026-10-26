import { ensure, isIntegerIn } from './validate.mjs'

/** How a read is failed: an HTTP error status, a dropped connection, or a 200 with broken JSON. */
export const FAULT_KINDS = [
  'http-error',
  'connection-failure',
  'invalid-json',
] as const

export type FaultKind = (typeof FAULT_KINDS)[number]

export const isFaultKind = (value: unknown): value is FaultKind =>
  (FAULT_KINDS as readonly unknown[]).includes(value)

// The fault APIs check JavaScript callers' options at runtime, each in its own order.
export const checkFaultKind = (kind: unknown) =>
  ensure(isFaultKind(kind), 'Unsupported fault kind', TypeError)

export const checkFaultCount = (count: number) =>
  ensure(
    isIntegerIn(count, 1, 20),
    'count must be an integer from 1 to 20',
    TypeError,
  )

export const checkFaultStatus = (kind: FaultKind, status: number) =>
  ensure(
    kind !== 'http-error' || isIntegerIn(status, 400, 599),
    'HTTP fault status must be from 400 to 599',
    TypeError,
  )

export const checkFaultMethod = (method: string) =>
  ensure(
    /^[A-Z]+$/.test(method),
    'method must be an uppercase HTTP method',
    TypeError,
  )

export const defaultFaults: readonly Readonly<{
  name: string
  kind: FaultKind
  status?: number
}>[] = Object.freeze([
  Object.freeze({
    name: 'HTTP 503 once',
    kind: 'http-error' as const,
    status: 503,
  }),
  Object.freeze({
    name: 'Interrupted request once',
    kind: 'connection-failure' as const,
  }),
  Object.freeze({ name: 'Malformed JSON once', kind: 'invalid-json' as const }),
])
