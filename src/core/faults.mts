/** How a read is failed: an HTTP error status, a dropped connection, or a 200 with broken JSON. */
export const FAULT_KINDS = [
  'http-error',
  'connection-failure',
  'invalid-json',
] as const

export type FaultKind = (typeof FAULT_KINDS)[number]

export const isFaultKind = (value: unknown): value is FaultKind =>
  (FAULT_KINDS as readonly unknown[]).includes(value)

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
