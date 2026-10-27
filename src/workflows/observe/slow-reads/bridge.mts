// In-page counter for a request/response bridge object, such as the one an Android app
// injects into its WebView. It counts messages sent with an id and the answers that
// carry the same id back. Installed for one capture and removed at its end.
import type { PageBridgeConfig } from './config.mjs'

export interface BridgeCounts {
  sent: number
  answered: number
  pending: number
  /** The most requests waiting at once since the previous read. */
  maxPending: number
}

interface BridgeCounter {
  token: string
  read(): BridgeCounts
  stop(): void
}

interface PageBridge {
  postMessage: (...args: unknown[]) => unknown
  addEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
  ) => void
  removeEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
  ) => void
}

declare global {
  // The bridge counter for the capture that owns this page.
  var __recoveryProbeBridge: BridgeCounter | undefined
}

// Runs in the page. Self-contained: page.evaluate serializes this function.
// eslint-disable-next-line max-lines-per-function -- serialized into the page as one function
export function installBridgeCounter({
  token,
  bridge: { global: name, idKey },
}: {
  token: string
  bridge: PageBridgeConfig
}): { installed: boolean; reason?: string } {
  const bridge = (globalThis as unknown as Record<string, Partial<PageBridge>>)[
    name
  ]
  if (
    typeof bridge?.postMessage !== 'function' ||
    typeof bridge.addEventListener !== 'function' ||
    typeof bridge.removeEventListener !== 'function'
  )
    return {
      installed: false,
      reason: `${name} has no postMessage, addEventListener and removeEventListener`,
    }
  const target = bridge as PageBridge
  globalThis.__recoveryProbeBridge?.stop()
  const pending = new Set<unknown>()
  let sent = 0,
    answered = 0,
    maxPending = 0
  const idOf = (data: unknown) => {
    try {
      const value =
        typeof data === 'string' && data.startsWith('{')
          ? JSON.parse(data)
          : data
      const id = value && typeof value === 'object' ? value[idKey] : undefined
      return id ?? undefined
    } catch {
      return undefined
    }
  }
  const post = target.postMessage
  const counted = function (this: unknown, ...args: unknown[]) {
    const id = idOf(args[0])
    if (id !== undefined) {
      pending.add(id)
      sent++
      maxPending = Math.max(maxPending, pending.size)
    }
    return post.apply(this, args)
  }
  const onMessage = (event: MessageEvent) => {
    const id = idOf(event.data)
    if (id !== undefined && pending.delete(id)) answered++
  }
  target.postMessage = counted
  if (target.postMessage !== counted)
    return {
      installed: false,
      reason: `${name}.postMessage cannot be replaced`,
    }
  target.addEventListener('message', onMessage)
  Object.defineProperty(globalThis, '__recoveryProbeBridge', {
    configurable: true,
    value: Object.freeze({
      token,
      read: () => {
        const counts = { sent, answered, pending: pending.size, maxPending }
        maxPending = pending.size
        return counts
      },
      stop: () => {
        if (target.postMessage === counted) target.postMessage = post
        target.removeEventListener('message', onMessage)
      },
    }),
  })
  return { installed: true }
}

// Runs in the page.
export function readBridgeCounter(token: string): BridgeCounts | null {
  const counter = globalThis.__recoveryProbeBridge
  return counter?.token === token ? counter.read() : null
}

// Runs in the page.
export function removeBridgeCounter(token: string): boolean {
  const counter = globalThis.__recoveryProbeBridge
  if (counter?.token !== token) return false
  counter.stop()
  delete globalThis.__recoveryProbeBridge
  return true
}
