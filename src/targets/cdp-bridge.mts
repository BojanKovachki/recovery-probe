import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** What CDP reports about a target, as far as the bridge needs it. */
export interface CdpTargetInfo {
  targetId: string
  type: string
  url: string
}

export interface CdpBridge {
  /** A loopback DevTools endpoint for `desktop --cdp` or a config's `cdp`. */
  url: string
  close(): Promise<void>
}

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 256 * 1024 * 1024
// Ids for the bridge's own commands, far above any a client uses.
const BRIDGE_ID_BASE = 2 ** 31

/** A page with nothing loaded, as Android keeps for a WebView that has no window yet. */
export const isBlankPage = (target: CdpTargetInfo): boolean =>
  target.type === 'page' && (target.url === '' || target.url === 'about:blank')

export interface WebSocketPeer {
  send(text: string): void
  close(): void
}

/** Accepts a WebSocket upgrade (RFC 6455) and delivers its text messages. */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  onMessage: (text: string) => void,
  onClose: () => void,
): WebSocketPeer {
  const key = request.headers['sec-websocket-key']
  const accept = createHash('sha1')
    .update(`${key}${ACCEPT_GUID}`)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  let closed = false
  const frame = (opcode: number, payload: Buffer) => {
    const length = payload.length
    const header =
      length < 126
        ? Buffer.from([0x80 | opcode, length])
        : length < 65536
          ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
          : Buffer.concat([
              Buffer.from([0x80 | opcode, 127]),
              (() => {
                const size = Buffer.alloc(8)
                size.writeBigUInt64BE(BigInt(length))
                return size
              })(),
            ])
    socket.write(Buffer.concat([header, payload]))
  }
  const close = () => {
    if (closed) return
    closed = true
    frame(0x8, Buffer.from([0x03, 0xe8])) // 1000: normal closure
    socket.end()
    onClose()
  }

  let buffered = Buffer.alloc(0)
  let message: Buffer[] = []
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      if (buffered.length < 2) return
      const fin = (buffered[0] & 0x80) !== 0
      const opcode = buffered[0] & 0x0f
      const masked = (buffered[1] & 0x80) !== 0
      let length = buffered[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffered.length < 4) return
        length = buffered.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffered.length < 10) return
        length = Number(buffered.readBigUInt64BE(2))
        offset = 10
      }
      if (length > MAX_MESSAGE) return close()
      const maskOffset = offset
      if (masked) offset += 4
      if (buffered.length < offset + length) return
      const payload = Buffer.from(buffered.subarray(offset, offset + length))
      if (masked)
        for (let i = 0; i < payload.length; i++)
          payload[i] ^= buffered[maskOffset + (i % 4)]
      buffered = buffered.subarray(offset + length)

      if (opcode === 0x8) return close()
      if (opcode === 0x9) frame(0xa, payload)
      else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        message.push(payload)
        if (fin) {
          const text = Buffer.concat(message).toString('utf8')
          message = []
          onMessage(text)
        }
      }
    }
  })
  socket.on('close', () => {
    if (!closed) {
      closed = true
      onClose()
    }
  })
  socket.on('error', () => socket.destroy())
  return { send: (text) => !closed && frame(0x1, Buffer.from(text)), close }
}

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
  const upstreamUrl = new URL(upstream)
  const peers = new Set<WebSocketPeer>()
  let url = ''

  const server = createServer(async (request, response) => {
    try {
      // Clients ask for both /json/version and /json/version/.
      const path = new URL(
        request.url ?? '/',
        'http://bridge',
      ).pathname.replace(/\/$/, '')
      if (path === '/json/version') {
        const version = (await (
          await fetch(new URL('/json/version', upstreamUrl))
        ).json()) as Record<string, unknown>
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ...version,
            webSocketDebuggerUrl: `${url.replace('http', 'ws')}/devtools/browser`,
          }),
        )
        return
      }
      if (path === '/json' || path === '/json/list') {
        const targets = (await (
          await fetch(new URL('/json/list', upstreamUrl))
        ).json()) as (CdpTargetInfo & Record<string, unknown>)[]
        // Page endpoints are not bridged: clients attach through the browser endpoint.
        const visible = targets
          .filter((target) => !hide({ ...target, targetId: String(target.id) }))
          .map(
            ({
              webSocketDebuggerUrl: _ws,
              devtoolsFrontendUrl: _frontend,
              ...target
            }) => target,
          )
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(visible))
        return
      }
      response.writeHead(404).end()
    } catch (error) {
      response.writeHead(502).end(String((error as Error).message))
    }
  })

  server.on('upgrade', (request, socket) => {
    if (
      new URL(request.url ?? '/', 'http://bridge').pathname !==
      '/devtools/browser'
    ) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const hiddenTargets = new Set<string>()
    const shownTargets = new Set<string>()
    const hiddenSessions = new Set<string>()
    // Decided once, when a target is first seen: hiding one the client already knows
    // would leave it waiting for events that never come.
    const isHidden = (target: CdpTargetInfo) => {
      if (shownTargets.has(target.targetId)) return false
      if (hiddenTargets.has(target.targetId)) return true
      if (hide(target)) hiddenTargets.add(target.targetId)
      else shownTargets.add(target.targetId)
      return hiddenTargets.has(target.targetId)
    }
    const queued: string[] = []
    let bridgeId = BRIDGE_ID_BASE
    const device = new WebSocket(
      `${upstreamUrl.origin.replace('http', 'ws')}/devtools/browser`,
    )
    const toDevice = (text: string) =>
      device.readyState === WebSocket.OPEN
        ? device.send(text)
        : queued.push(text)

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

    const forward = (text: string) => {
      const message = JSON.parse(text)
      if (message.sessionId && hiddenSessions.has(message.sessionId)) return
      if (message.id >= BRIDGE_ID_BASE) return
      const info = message.params?.targetInfo as CdpTargetInfo | undefined
      const hidden = info ? isHidden(info) : false
      switch (message.method) {
        case 'Target.attachedToTarget':
          if (hidden) {
            hiddenSessions.add(message.params.sessionId)
            // Left paused, the page would never start.
            if (message.params.waitingForDebugger)
              toDevice(
                JSON.stringify({
                  id: bridgeId++,
                  method: 'Runtime.runIfWaitingForDebugger',
                  sessionId: message.params.sessionId,
                }),
              )
            return
          }
          break
        case 'Target.targetCreated':
        case 'Target.targetInfoChanged':
          if (hidden) return
          break
        case 'Target.targetDestroyed':
        case 'Target.targetCrashed':
        case 'Target.detachedFromTarget':
          if (
            hiddenTargets.has(message.params?.targetId) ||
            hiddenSessions.has(message.params?.sessionId)
          )
            return
          break
      }
      if (Array.isArray(message.result?.targetInfos)) {
        message.result.targetInfos = message.result.targetInfos.filter(
          (target: CdpTargetInfo) => !isHidden(target),
        )
        client.send(JSON.stringify(message))
        return
      }
      client.send(text)
    }
    device.addEventListener('message', (event) => forward(String(event.data)))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return {
    url,
    async close() {
      for (const peer of peers) peer.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
