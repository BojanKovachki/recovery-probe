import type { IncomingMessage, RequestListener } from 'node:http'
import { hasLoopbackHost } from '../../core/server.mjs'
import { CONTROL_HEADER, CONTROL_PATH } from './client.mjs'
import type { NetworkFaultRule, NetworkFaultSummary } from './types.mjs'

/** Runs one control action with its JSON body and returns the JSON answer. */
export type ControlHandler = (action: string, body: unknown) => unknown

const MAX_CONTROL_BODY = 64 * 1024

const failure = (message: string, status: number) =>
  Object.assign(new Error(message), { status })

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_CONTROL_BODY) throw failure('Request too large', 413)
    chunks.push(chunk)
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

/** The proxy's plain HTTP side: the control API when it has one, otherwise 501. */
export function controlListener(handle?: ControlHandler): RequestListener {
  return (request, response) => {
    const reply = (status: number, body: unknown) =>
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(body))
    if (!handle || !request.url?.startsWith(CONTROL_PATH)) {
      // Plain HTTP is not routed here; only HTTPS tunnels are.
      response.writeHead(501).end('Recovery Probe tunnels HTTPS (CONNECT) only')
      return
    }
    // A same-origin page after DNS rebinding can send the control header too.
    if (!hasLoopbackHost(request)) {
      reply(403, { error: 'Use the proxy loopback host and port' })
      return
    }
    // Other web pages cannot send this header without a preflight, never answered here.
    if (request.headers[CONTROL_HEADER] !== 'network') {
      reply(403, { error: `Send the ${CONTROL_HEADER}: network header` })
      return
    }
    readJson(request)
      .then((body) => handle(request.url!.slice(CONTROL_PATH.length), body))
      .then(
        (result) => reply(200, result),
        (error: Error & { status?: number }) =>
          reply(error.status ?? 400, { error: error.message }),
      )
  }
}

/** Answers the control actions from the proxy's own methods. */
export function controlActions(proxy: {
  arm(rules: NetworkFaultRule[]): void
  disarm(): void
  dropOpen(host?: string): number
  summary(): NetworkFaultSummary
}): ControlHandler {
  return (action, body) => {
    const { rules, host } = (body ?? {}) as { rules?: unknown; host?: unknown }
    if (action === 'summary') return proxy.summary()
    if (action === 'arm') {
      proxy.arm(rules as NetworkFaultRule[])
      return {}
    }
    if (action === 'disarm') {
      proxy.disarm()
      return {}
    }
    if (action === 'drop')
      return {
        dropped: proxy.dropOpen(typeof host === 'string' ? host : undefined),
      }
    throw failure('Unknown control action', 404)
  }
}
