import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const publicDir = join(root, 'public')
const port = Number(process.env.PORT ?? 4173)

// Every start serves the same orders, so a restart resets the data.
const seed = JSON.parse(
  await readFile(join(root, 'data', 'orders.json'), 'utf8'),
)
const orders = structuredClone(seed)

// Listing every order scans the whole table; a status filter uses an index.
const LIST_ALL_MS = 900
const LIST_FILTERED_MS = 120
const UPDATE_MS = 150
const STATUSES = ['new', 'packed', 'shipped']

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

async function bodyOf(request) {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) : {}
}

async function listOrders(url, response) {
  const status = url.searchParams.get('status')
  await sleep(status ? LIST_FILTERED_MS : LIST_ALL_MS)
  send(
    response,
    200,
    status ? orders.filter((order) => order.status === status) : orders,
  )
}

async function updateStatus(id, request, response) {
  const order = orders.find((candidate) => candidate.id === id)
  if (!order) return send(response, 404, { error: 'No such order' })
  const { status } = await bodyOf(request)
  if (!STATUSES.includes(status))
    return send(response, 400, { error: 'Unknown status' })
  await sleep(UPDATE_MS)
  order.status = status
  order.updatedAt = new Date().toISOString()
  send(response, 200, order)
}

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/orders')
    return listOrders(url, response)
  const status = url.pathname.match(/^\/api\/orders\/([\w-]+)\/status$/)
  if (request.method === 'POST' && status)
    return updateStatus(status[1], request, response)
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
  console.log(`Dispatch console on http://127.0.0.1:${port}`),
)
