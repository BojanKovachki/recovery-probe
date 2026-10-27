import { createServer, type IncomingMessage } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import { closeServer, listenOnLoopback } from '../../core/server.mjs'
import { controlActions, controlListener } from './control.mjs'
import { ArmedRules, validateNetworkRules } from './rules.mjs'
import { parseAuthority, refuse, Tunnels } from './tunnels.mjs'
import type {
  NetworkConnectionEvent,
  NetworkFaultProxy,
  NetworkFaultRule,
  NetworkFaultSummary,
} from './types.mjs'

const MAX_EVENTS = 10_000

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
    /** Answer `connectNetworkFaults` on the proxy's own address. */
    control?: boolean
  } = {},
): Promise<NetworkFaultProxy> {
  // Validated before listening, so invalid rules leave no server behind.
  const initialRules =
    options.rules === undefined
      ? undefined
      : validateNetworkRules(options.rules)
  const faults = new FaultProxy()
  const server = createServer(
    controlListener(options.control ? controlActions(faults) : undefined),
  )
  server.on(
    'connect',
    (request: IncomingMessage, client: Duplex, head: Buffer) =>
      faults.connect(request, client, head),
  )
  const port = await listenOnLoopback(server, options.port ?? 0)
  const url = `http://127.0.0.1:${port}`
  const proxy: NetworkFaultProxy = {
    url,
    port,
    env: () => ({ HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,::1' }),
    arm: (rules) => faults.arm(rules),
    disarm: () => faults.disarm(),
    dropOpen: (host) => faults.dropOpen(host),
    events: () => faults.events(),
    summary: () => faults.summary(),
    assertApplied: () => faults.assertApplied(),
    async close() {
      faults.disarm()
      faults.dropOpen()
      await closeServer(server)
    },
  }
  if (initialRules && options.armOnFirstConnection)
    faults.armOnFirstConnection(initialRules)
  else if (initialRules) faults.arm(initialRules)
  return proxy
}

/** The proxy's state: the armed rules, the open tunnels and the connection log. */
class FaultProxy {
  readonly #startedAt = performance.now()
  readonly #events: NetworkConnectionEvent[] = []
  readonly #rules = new ArmedRules()
  readonly #tunnels = new Tunnels()
  #ruleTimers: NodeJS.Timeout[] = []
  #connections = 0
  #pending: NetworkFaultRule[] | undefined

  /** Arms `rules` when the next connection arrives; arming or disarming first cancels it. */
  armOnFirstConnection(rules: NetworkFaultRule[]): void {
    this.#pending = rules
  }

  arm(next: NetworkFaultRule[]): void {
    const validated = validateNetworkRules(next)
    this.disarm()
    const { rules, armedAt } = this.#rules.arm(validated)
    for (const rule of rules.filter((rule) => rule.dropOpen)) {
      const startsAt = armedAt + (rule.fromMs ?? 0)
      this.#ruleTimers.push(
        setTimeout(() => this.dropOpen(rule.host, startsAt), rule.fromMs ?? 0),
      )
    }
  }

  disarm(): void {
    this.#rules.disarm()
    this.#pending = undefined
    this.#ruleTimers.forEach(clearTimeout)
    this.#ruleTimers = []
  }

  dropOpen(host?: string, openedBefore?: number): number {
    return this.#tunnels.dropOpen(host, openedBefore)
  }

  events(): NetworkConnectionEvent[] {
    return [...this.#events]
  }

  summary(): NetworkFaultSummary {
    return {
      connections: this.#connections,
      eventsDropped: this.#connections - this.#events.length,
      rules: this.#rules.summaries(),
    }
  }

  assertApplied(): NetworkFaultSummary {
    const result = this.summary()
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
  }

  /** Tunnels one CONNECT, or fails it the way the first matching rule says. */
  connect(request: IncomingMessage, client: Duplex, head: Buffer): void {
    const target = parseAuthority(request.url ?? '')
    if (!target) {
      refuse(client)
      return
    }
    const { host, port } = target
    // Armed first, so the connection that arms the rules is not one opened before them.
    if (this.#pending) this.arm(this.#pending)
    const tunnel = this.#tunnels.open(target, client, head)
    const index = this.#rules.select(host)
    if (index === -1) {
      this.#tunnels.passThrough(tunnel, (outcome) =>
        this.#record({ host, port, outcome }),
      )
      return
    }
    const rule = this.#rules.at(index)
    this.#record({ host, port, outcome: rule.fault, rule: index })
    this.#tunnels.fault(tunnel, rule)
  }

  #record(event: Omit<NetworkConnectionEvent, 'at'>): void {
    this.#connections += 1
    if (this.#events.length < MAX_EVENTS)
      this.#events.push({
        at: Math.round(performance.now() - this.#startedAt),
        ...event,
      })
  }
}
