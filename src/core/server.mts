import type { IncomingMessage, Server } from 'node:http'

/** Reject DNS aliases and ambiguous authorities before exposing local controls. */
export function hasLoopbackHost(request: IncomingMessage): boolean {
  const hosts = request.headersDistinct.host
  if (hosts?.length !== 1 || !request.socket.localPort) return false
  const port = request.socket.localPort
  return hosts[0] === `127.0.0.1:${port}` || hosts[0] === `localhost:${port}`
}

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
