import { connect, createServer } from 'node:net'

/** Whether something accepts connections on `url`'s host and port. */
export async function portOpen(url: URL): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

/** A loopback port that was free a moment ago. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}
