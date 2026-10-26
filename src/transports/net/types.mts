// The public types of recovery-probe/net. They stay free of Node types, so a
// consumer can type-check against them without @types/node.

export type NetworkFault = 'refuse' | 'reset' | 'stall' | 'delay'

export interface NetworkFaultRule {
  /** A host name, `*.example.com` for its subdomains, or `*` for every host. */
  host: string
  fault: NetworkFault
  /** For `delay`: how long a connection waits before it goes through. */
  delayMs?: number
  /** How many connections to fault; every matching one when left out. */
  count?: number
  /** When the rule applies, in milliseconds after it is armed. */
  fromMs?: number
  untilMs?: number
  /** Close the open connections to the host when the rule starts to apply. */
  dropOpen?: boolean
}

export type NetworkOutcome = 'passed' | 'upstream-error' | NetworkFault

export interface NetworkConnectionEvent {
  /** Milliseconds after the proxy started. */
  at: number
  host: string
  port: number
  outcome: NetworkOutcome
  /** Index of the rule that faulted the connection. */
  rule?: number
}

export interface NetworkRuleSummary {
  host: string
  fault: NetworkFault
  /** Connections to the rule's host while it applied. */
  matching: number
  applied: number
}

export interface NetworkFaultSummary {
  connections: number
  /** Connections left out of `events()` once it holds its maximum. */
  eventsDropped: number
  rules: NetworkRuleSummary[]
}

export interface NetworkFaultProxy {
  /** The proxy URL, for `HTTPS_PROXY`. */
  readonly url: string
  readonly port: number
  /** Environment that routes a client's HTTPS connections through the proxy. */
  env(): { HTTPS_PROXY: string; NO_PROXY: string }
  /** Replaces the armed rules; their windows start now. */
  arm(rules: NetworkFaultRule[]): void
  disarm(): void
  /** Closes the open connections to hosts matching `host`, or all of them. */
  dropOpen(host?: string): number
  events(): NetworkConnectionEvent[]
  summary(): NetworkFaultSummary
  /** Throws `FAULT_NOT_TRIGGERED` when an armed rule faulted no connection. */
  assertApplied(): NetworkFaultSummary
  close(): Promise<void>
}

export interface NetworkFaultControl {
  arm(rules: NetworkFaultRule[]): Promise<void>
  disarm(): Promise<void>
  dropOpen(host?: string): Promise<number>
  summary(): Promise<NetworkFaultSummary>
}
