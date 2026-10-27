import { createServer } from 'node:net'

/**
 * Listens on a free loopback port and resolves with it.
 * @param {import('node:net').Server} server
 */
export async function listen(server) {
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  )
  return /** @type {import('node:net').AddressInfo} */ (server.address()).port
}

/** A loopback port that was free a moment ago. */
export async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}
