const TIMEOUT_MS = 5000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** Only the developer's explicitly selected loopback Node inspector is supported. */
export function loopback(raw: string, protocols: string[]): URL {
  const url = new URL(raw)
  if (
    !protocols.includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('Inspector must use a loopback address without credentials')
  return url
}

/** The inspector's WebSocket URL: given directly, or the one Node target on an HTTP port. */
export async function debuggerUrl(endpoint: string): Promise<URL> {
  const url = loopback(endpoint, ['http:', 'ws:'])
  if (url.protocol !== 'http:') return url
  const response = await fetch(new URL('/json/list', url), {
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok)
    throw new Error(`Inspector discovery returned HTTP ${response.status}`)
  const targets = (
    (await response.json()) as {
      type?: string
      webSocketDebuggerUrl?: string
    }[]
  ).filter((item) => item.type === 'node' && item.webSocketDebuggerUrl)
  if (targets.length !== 1)
    throw new Error('Expected exactly one Node inspector target on this port')
  const discovered = loopback(targets[0].webSocketDebuggerUrl!, ['ws:'])
  if (discovered.port !== url.port)
    throw new Error('Inspector discovery changed ports')
  return discovered
}

/** A DevTools protocol connection: each command waits for its own reply or times out. */
export class InspectorSocket {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, Pending>()
  #next = 0

  private constructor(url: URL) {
    this.#socket = new WebSocket(url)
    this.#socket.addEventListener('message', (event) => this.#reply(event))
    this.#socket.addEventListener('close', () => this.#rejectAll())
  }

  static async open(url: URL): Promise<InspectorSocket> {
    const connection = new InspectorSocket(url)
    await connection.#opened()
    return connection
  }

  readonly send = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      if (this.#socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Inspector is not connected'))
        return
      }
      const id = ++this.#next
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('Inspector command timed out'))
      }, TIMEOUT_MS)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })

  close() {
    this.#socket.close()
  }

  #opened() {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#socket.close()
        reject(new Error('Inspector connection timed out'))
      }, TIMEOUT_MS)
      this.#socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      this.#socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('Cannot connect to Node inspector'))
        },
        { once: true },
      )
    })
  }

  #reply(event: MessageEvent) {
    const message = JSON.parse(event.data)
    const item = this.#pending.get(message.id)
    if (!item) return
    this.#pending.delete(message.id)
    clearTimeout(item.timer)
    if (message.error) item.reject(new Error(message.error.message))
    else item.resolve(message.result)
  }

  #rejectAll() {
    for (const item of this.#pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Inspector disconnected'))
    }
    this.#pending.clear()
  }
}
