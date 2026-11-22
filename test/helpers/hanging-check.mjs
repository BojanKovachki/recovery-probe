import { createServer } from 'node:net'

/**
 * A debugging port that accepts connections and never answers, and a check config that
 * attaches to it, so the check waits until it's stopped. `connected` rejects when no
 * check connects within 30 s, so a check that fails to start fails the test instead of
 * hanging it. `closed` resolves when the check's connection ends: its process has gone.
 */
export async function hangingCheck() {
  /** @type {import('node:net').Socket[]} */
  const sockets = []
  /** @type {(socket: import('node:net').Socket) => void} */
  let connect = () => {}
  /** @type {Promise<import('node:net').Socket>} */
  const connected = new Promise((resolve, reject) => {
    connect = resolve
    setTimeout(() => reject(new Error('No check connected')), 30000).unref()
  })
  const closed = connected.then(
    (socket) => new Promise((resolve) => socket.once('close', resolve)),
  )
  // A test that never got a connection fails on `connected`; this rejection adds nothing.
  closed.catch(() => {})
  const server = createServer((socket) => {
    socket.on('error', () => {})
    // Read and drop the request: a socket left unread never sees the connection end.
    socket.resume()
    sockets.push(socket)
    connect(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  )
  return {
    config: JSON.stringify({
      cdp: `http://127.0.0.1:${port}`,
      pageUrl: 'http://127.0.0.1:9/items.html',
      endpoint: 'http://127.0.0.1:9/api/items',
      readySelector: '#items',
      recovery: 'automatic',
    }),
    connected,
    closed,
    close() {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
