import { connect, type Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import { hostMatches } from './rules.mjs'
import type { NetworkFaultRule, NetworkOutcome } from './types.mjs'

interface Tunnel {
  host: string
  port: number
  openedAt: number
  client: Duplex
  /** What the client sent with its CONNECT, before the tunnel was set up. */
  head: Buffer
  upstream?: Socket
  timer?: NodeJS.Timeout
}

const ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n'
const REFUSED = 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'

export const refuse = (client: Duplex) => client.end(REFUSED)

/** The host and port of a CONNECT request's target, or null when it has none. */
export function parseAuthority(
  authority: string,
): { host: string; port: number } | null {
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

/** The open CONNECT tunnels: passed through to the host, or failed by a rule. */
export class Tunnels {
  readonly #open = new Set<Tunnel>()

  open(target: { host: string; port: number }, client: Duplex, head: Buffer) {
    const tunnel: Tunnel = {
      host: target.host,
      port: target.port,
      openedAt: performance.now(),
      client,
      head,
    }
    this.#open.add(tunnel)
    client.on('error', () => this.close(tunnel))
    client.once('close', () => this.close(tunnel))
    return tunnel
  }

  close(tunnel: Tunnel): void {
    clearTimeout(tunnel.timer)
    tunnel.client.destroy()
    tunnel.upstream?.destroy()
    this.#open.delete(tunnel)
  }

  /** Connects the tunnel to its host; `onResult` hears whether that worked. */
  passThrough(
    tunnel: Tunnel,
    onResult?: (outcome: NetworkOutcome) => void,
  ): void {
    const upstream = connect(tunnel.port, tunnel.host)
    let connected = false
    tunnel.upstream = upstream
    upstream.once('connect', () => {
      connected = true
      onResult?.('passed')
      tunnel.client.write(ESTABLISHED)
      if (tunnel.head.length) upstream.write(tunnel.head)
      upstream.pipe(tunnel.client)
      tunnel.client.pipe(upstream)
    })
    upstream.once('error', () => {
      if (!connected) {
        onResult?.('upstream-error')
        tunnel.client.end(REFUSED)
      }
      this.close(tunnel)
    })
    upstream.once('close', () => this.close(tunnel))
  }

  /** Fails the tunnel the way `rule` says. */
  fault(tunnel: Tunnel, rule: NetworkFaultRule): void {
    const { client, head } = tunnel
    switch (rule.fault) {
      case 'refuse':
        refuse(client)
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
        tunnel.timer = setTimeout(() => this.passThrough(tunnel), rule.delayMs)
    }
  }

  /** Closes the tunnels to hosts matching `host` (all when left out) opened before `openedBefore`. */
  dropOpen(host?: string, openedBefore = Infinity): number {
    let dropped = 0
    for (const tunnel of [...this.#open]) {
      if (host !== undefined && !hostMatches(host.toLowerCase(), tunnel.host))
        continue
      if (tunnel.openedAt >= openedBefore) continue
      this.close(tunnel)
      dropped += 1
    }
    return dropped
  }
}
