import { createServer, type IncomingMessage } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

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

interface ArmedRule extends NetworkFaultRule {
  matching: number
  applied: number
}

interface Tunnel {
  host: string
  openedAt: number
  client: Duplex
  upstream?: Socket
  timer?: NodeJS.Timeout
}

const FAULTS = new Set<unknown>(['refuse', 'reset', 'stall', 'delay'])
const MAX_EVENTS = 10_000
const ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n'
const REFUSED = 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'

const isWholeNumber = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0

export function hostMatches(pattern: string, host: string): boolean {
  const name = host.toLowerCase()
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1))
  return name === pattern
}

export function validateNetworkRules(rules: unknown): NetworkFaultRule[] {
  if (!Array.isArray(rules) || rules.length === 0)
    throw new TypeError('rules must be a non-empty array')
  return rules.map((rule, index) => {
    const where = `rules[${index}]`
    if (typeof rule?.host !== 'string' || !rule.host.trim())
      throw new TypeError(`${where}.host must be a host name`)
    if (!FAULTS.has(rule.fault))
      throw new TypeError(
        `${where}.fault must be refuse, reset, stall or delay`,
      )
    if (rule.fault === 'delay' && !isWholeNumber(rule.delayMs))
      throw new TypeError(
        `${where}.delayMs must be a whole number of milliseconds`,
      )
    if (
      rule.count !== undefined &&
      !(isWholeNumber(rule.count) && rule.count > 0)
    )
      throw new TypeError(`${where}.count must be a positive integer`)
    for (const key of ['fromMs', 'untilMs'] as const)
      if (rule[key] !== undefined && !isWholeNumber(rule[key]))
        throw new TypeError(
          `${where}.${key} must be a whole number of milliseconds`,
        )
    if (rule.untilMs !== undefined && rule.untilMs <= (rule.fromMs ?? 0))
      throw new TypeError(`${where}.untilMs must be after fromMs`)
    return { ...rule, host: rule.host.trim().toLowerCase() }
  })
}

const parseAuthority = (
  authority: string,
): { host: string; port: number } | null => {
  const separator = authority.lastIndexOf(':')
  const host = authority.slice(0, separator).replace(/^\[(.*)\]$/, '$1')
  const port = Number(authority.slice(separator + 1))
  if (
    separator <= 0 ||
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return null
  return { host: host.toLowerCase(), port }
}

/**
 * Starts a loopback HTTPS proxy that fails whole connections per host. HTTPS stays
 * end to end, so it sees only the host and port: it cannot change a response.
 */
export async function startNetworkFaultProxy(
  options: {
    port?: number
    rules?: NetworkFaultRule[]
    /** Arm `rules` on the first connection, so their windows start with the app. */
    armOnFirstConnection?: boolean
  } = {},
): Promise<NetworkFaultProxy> {
  // Validated before listening, so invalid rules leave no server behind.
  const initialRules =
    options.rules === undefined
      ? undefined
      : validateNetworkRules(options.rules)
  const startedAt = Date.now()
  const events: NetworkConnectionEvent[] = []
  const tunnels = new Set<Tunnel>()
  let rules: ArmedRule[] = []
  let active = false
  let armedAt = 0
  let ruleTimers: NodeJS.Timeout[] = []
  let connections = 0
  let pending: NetworkFaultRule[] | undefined

  const record = (event: Omit<NetworkConnectionEvent, 'at'>): void => {
    connections += 1
    if (events.length < MAX_EVENTS)
      events.push({ at: Date.now() - startedAt, ...event })
  }

  /** The index of the rule that faults a connection to `host`, or -1. */
  const select = (host: string): number => {
    if (!active) return -1
    const elapsed = Date.now() - armedAt
    let selected = -1
    rules.forEach((rule, index) => {
      if (!hostMatches(rule.host, host)) return
      if (elapsed < (rule.fromMs ?? 0)) return
      if (rule.untilMs !== undefined && elapsed >= rule.untilMs) return
      rule.matching += 1
      if (
        selected === -1 &&
        (rule.count === undefined || rule.applied < rule.count)
      )
        selected = index
    })
    if (selected !== -1) rules[selected].applied += 1
    return selected
  }

  const close = (tunnel: Tunnel): void => {
    clearTimeout(tunnel.timer)
    tunnel.client.destroy()
    tunnel.upstream?.destroy()
    tunnels.delete(tunnel)
  }

  const passThrough = (
    tunnel: Tunnel,
    head: Buffer,
    port: number,
    onResult?: (outcome: NetworkOutcome) => void,
  ): void => {
    const upstream = connect(port, tunnel.host)
    let connected = false
    tunnel.upstream = upstream
    upstream.once('connect', () => {
      connected = true
      onResult?.('passed')
      tunnel.client.write(ESTABLISHED)
      if (head.length) upstream.write(head)
      upstream.pipe(tunnel.client)
      tunnel.client.pipe(upstream)
    })
    upstream.once('error', () => {
      if (!connected) {
        onResult?.('upstream-error')
        tunnel.client.end(REFUSED)
      }
      close(tunnel)
    })
    upstream.once('close', () => close(tunnel))
  }

  const server = createServer((_request, response) => {
    // Plain HTTP is not routed here; only HTTPS tunnels are.
    response.writeHead(501).end('Recovery Probe tunnels HTTPS (CONNECT) only')
  })

  server.on(
    'connect',
    (request: IncomingMessage, client: Duplex, head: Buffer) => {
      const target = parseAuthority(request.url ?? '')
      if (!target) {
        client.end(REFUSED)
        return
      }
      const { host, port } = target
      const tunnel: Tunnel = { host, openedAt: Date.now(), client }
      tunnels.add(tunnel)
      client.on('error', () => close(tunnel))
      client.once('close', () => close(tunnel))

      if (pending) proxy.arm(pending)
      const index = select(host)
      if (index === -1) {
        passThrough(tunnel, head, port, (outcome) =>
          record({ host, port, outcome }),
        )
        return
      }
      const rule = rules[index]
      record({ host, port, outcome: rule.fault, rule: index })
      switch (rule.fault) {
        case 'refuse':
          client.end(REFUSED)
          return
        case 'reset':
          client.write(ESTABLISHED)
          // Reset once the client starts its handshake.
          if (head.length) (client as Socket).resetAndDestroy()
          else client.once('data', () => (client as Socket).resetAndDestroy())
          return
        case 'stall':
          return
        case 'delay':
          tunnel.timer = setTimeout(
            () => passThrough(tunnel, head, port),
            rule.delayMs,
          )
      }
    },
  )

  const dropOpen = (host?: string, openedBefore = Infinity): number => {
    let dropped = 0
    for (const tunnel of [...tunnels]) {
      if (host !== undefined && !hostMatches(host.toLowerCase(), tunnel.host))
        continue
      if (tunnel.openedAt >= openedBefore) continue
      close(tunnel)
      dropped += 1
    }
    return dropped
  }

  const disarm = (): void => {
    active = false
    pending = undefined
    ruleTimers.forEach(clearTimeout)
    ruleTimers = []
  }

  const summary = (): NetworkFaultSummary => ({
    connections,
    eventsDropped: connections - events.length,
    rules: rules.map(({ host, fault, matching, applied }) => ({
      host,
      fault,
      matching,
      applied,
    })),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const url = `http://127.0.0.1:${port}`

  const proxy: NetworkFaultProxy = {
    url,
    port,
    env: () => ({ HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,::1' }),
    arm(next) {
      const validated = validateNetworkRules(next)
      disarm()
      rules = validated.map((rule) => ({ ...rule, matching: 0, applied: 0 }))
      armedAt = Date.now()
      active = true
      for (const rule of rules.filter((rule) => rule.dropOpen)) {
        const startsAt = armedAt + (rule.fromMs ?? 0)
        ruleTimers.push(
          setTimeout(() => dropOpen(rule.host, startsAt), rule.fromMs ?? 0),
        )
      }
    },
    disarm,
    dropOpen: (host) => dropOpen(host),
    events: () => [...events],
    summary,
    assertApplied() {
      const result = summary()
      const idle = result.rules.filter((rule) => rule.applied === 0)
      if (idle.length) {
        throw Object.assign(
          new Error(
            `No connection was faulted for ${idle.map((rule) => `${rule.fault} ${rule.host}`).join(', ')}.`,
          ),
          { code: 'FAULT_NOT_TRIGGERED', stats: result },
        )
      }
      return result
    },
    async close() {
      disarm()
      dropOpen()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  if (initialRules && options.armOnFirstConnection) pending = initialRules
  else if (initialRules) proxy.arm(initialRules)
  return proxy
}
