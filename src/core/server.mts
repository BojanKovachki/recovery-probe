import type { Server } from 'node:http'

/** Listens on 127.0.0.1 and returns the port; port 0 picks a free one. */
export async function listenOnLoopback(
  server: Server,
  port: number,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

/** Closes the server and the connections it still holds. */
export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
