// Starts an app's server from a directory on a free port, for one check at a time.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

async function freePort() {
  const server = createServer()
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  )
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  )
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForServer(origin, child, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('the server exited')
    try {
      const response = await fetch(origin)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`the server did not answer within ${ms} ms`)
}

/** Starts `server.mjs` in `directory`; resolves with its origin and a stop function. */
export async function serve(directory) {
  const port = await freePort()
  const child = spawn(process.execPath, [join(directory, 'server.mjs')], {
    cwd: directory,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let errors = ''
  child.stderr.on('data', (chunk) => (errors += chunk))
  const origin = `http://127.0.0.1:${port}`
  try {
    await waitForServer(origin, child, 10000)
  } catch (error) {
    child.kill()
    throw new Error(`${error.message}${errors ? `: ${errors.trim()}` : ''}`, {
      cause: error,
    })
  }
  return {
    origin,
    async stop() {
      if (child.exitCode !== null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await exited
    },
  }
}
