import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import { closeServer, listenOnLoopback } from '../../core/server.mjs'
import { BRIDGE_ID_BASE, TargetFilter, type CdpTargetInfo } from './filter.mjs'
import { acceptWebSocket, type WebSocketPeer } from './websocket.mjs'

export interface CdpBridge {
  /** A loopback DevTools endpoint for `desktop --cdp` or a config's `cdp`. */
  url: string
  close(): Promise<void>
}

interface BridgeContext {
  upstream: URL
  hide: (target: CdpTargetInfo) => boolean
  /** The bridge's own URL, known once it listens. */
  url: () => string
}

/** A page with nothing loaded, as Android keeps for a WebView that has no window yet. */
export const isBlankPage = (target: CdpTargetInfo): boolean =>
  target.type === 'page' && (target.url === '' || target.url === 'about:blank')

/**
 * Serves a loopback DevTools endpoint that passes everything through to `upstream`
 * except the targets `hide` picks. A client never sees those, so it does not wait for
 * them; ones paused for a debugger are let run.
 */
export async function startCdpBridge({
  upstream,
  hide = isBlankPage,
  port = 0,
}: {
  upstream: string
  hide?: (target: CdpTargetInfo) => boolean
  port?: number
}): Promise<CdpBridge> {
  let url = ''
  const context: BridgeContext = {
    upstream: new URL(upstream),
    hide,
    url: () => url,
  }
  const peers = new Set<WebSocketPeer>()
  const server = createServer((request, response) =>
    answer(context, request, response),
  )
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) =>
    bridgeClient(context, peers, request, socket),
  )
  url = `http://127.0.0.1:${await listenOnLoopback(server, port)}`
  return {
    url,
    async close() {
      for (const peer of peers) peer.close()
      await closeServer(server)
    },
  }
}

async function answer(
  context: BridgeContext,
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    // Clients ask for both /json/version and /json/version/.
    const path = new URL(request.url ?? '/', 'http://bridge').pathname.replace(
      /\/$/,
      '',
    )
    if (path === '/json/version') return json(response, await version(context))
    if (path === '/json' || path === '/json/list')
      return json(response, await visibleTargets(context))
    response.writeHead(404).end()
  } catch (error) {
    response.writeHead(502).end(String((error as Error).message))
  }
}

function json(response: ServerResponse, body: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const fetchJson = async (context: BridgeContext, path: string) =>
  (await fetch(new URL(path, context.upstream))).json()

async function version(context: BridgeContext) {
  const upstream = (await fetchJson(context, '/json/version')) as Record<
    string,
    unknown
  >
  return {
    ...upstream,
    webSocketDebuggerUrl: `${context.url().replace('http', 'ws')}/devtools/browser`,
  }
}

async function visibleTargets(context: BridgeContext) {
  const targets = (await fetchJson(context, '/json/list')) as (CdpTargetInfo &
    Record<string, unknown>)[]
  // Page endpoints are not bridged: clients attach through the browser endpoint.
  return targets
    .filter(
      (target) => !context.hide({ ...target, targetId: String(target.id) }),
    )
    .map(
      ({
        webSocketDebuggerUrl: _ws,
        devtoolsFrontendUrl: _frontend,
        ...target
      }) => target,
    )
}

/** Connects one client to the device's browser endpoint, through a target filter. */
function bridgeClient(
  context: BridgeContext,
  peers: Set<WebSocketPeer>,
  request: IncomingMessage,
  socket: Duplex,
) {
  if (
    new URL(request.url ?? '/', 'http://bridge').pathname !==
    '/devtools/browser'
  ) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  const queued: string[] = []
  let bridgeId = BRIDGE_ID_BASE
  const device = new WebSocket(
    `${context.upstream.origin.replace('http', 'ws')}/devtools/browser`,
  )
  const toDevice = (text: string) =>
    device.readyState === WebSocket.OPEN ? device.send(text) : queued.push(text)
  const filter = new TargetFilter(context.hide, (sessionId) =>
    toDevice(
      JSON.stringify({
        id: bridgeId++,
        method: 'Runtime.runIfWaitingForDebugger',
        sessionId,
      }),
    ),
  )
  const client = acceptWebSocket(request, socket, toDevice, () =>
    device.close(),
  )
  peers.add(client)
  device.addEventListener('open', () => {
    for (const text of queued.splice(0)) device.send(text)
  })
  device.addEventListener('close', () => {
    peers.delete(client)
    client.close()
  })
  device.addEventListener('error', () => client.close())
  device.addEventListener('message', (event) => {
    const text = filter.forward(String(event.data))
    if (text !== undefined) client.send(text)
  })
}
