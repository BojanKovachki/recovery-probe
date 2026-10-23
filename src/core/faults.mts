export type FaultKind = 'http-error' | 'connection-failure' | 'invalid-json'

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
