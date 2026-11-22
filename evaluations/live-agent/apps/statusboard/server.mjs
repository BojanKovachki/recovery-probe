import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const publicDir = join(root, 'public')
const port = Number(process.env.PORT ?? 4173)

const read = async (name) =>
  JSON.parse(await readFile(join(root, 'data', name), 'utf8'))

// Every start loads the same data, so a restart resets the board.
const account = await read('account.json')
const services = await read('services.json')
const notifications = await read('notifications.json')
// What the upstream status service answers for each service during a sync.
const upstream = await read('upstream.json')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

/** Asks upstream for each service's state; services it does not answer for keep theirs. */
async function sync() {
  const updated = []
  const failed = []
  for (const service of services) {
    await sleep(80)
    const answer = upstream[service.id]
    if (typeof answer === 'string') {
      service.state = answer
      service.checkedAt = new Date().toISOString()
      updated.push(service.id)
    } else failed.push(service.id)
  }
  return { syncedAt: new Date().toISOString(), updated, failed }
}

async function api(request, response, url) {
  const route = `${request.method} ${url.pathname}`
  if (route === 'GET /api/account') return send(response, 200, account)
  if (route === 'GET /api/services') {
    await sleep(150)
    return send(response, 200, services)
  }
  if (route === 'GET /api/notifications') {
    await sleep(150)
    return send(response, 200, notifications[account.user] ?? [])
  }
  if (route === 'POST /api/sync') return send(response, 200, await sync())
  send(response, 404, { error: 'Not found' })
}

async function file(response, pathname) {
  const path = normalize(
    join(publicDir, pathname === '/' ? 'index.html' : pathname),
  )
  if (!path.startsWith(publicDir + sep)) return send(response, 404, {})
  try {
    const body = await readFile(path)
    response.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    response.end(body)
  } catch {
    send(response, 404, { error: 'Not found' })
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const work = url.pathname.startsWith('/api/')
    ? api(request, response, url)
    : file(response, url.pathname)
  work.catch((error) => send(response, 500, { error: error.message }))
})

server.listen(port, '127.0.0.1', () =>
  console.log(`Status board on http://127.0.0.1:${port}`),
)
