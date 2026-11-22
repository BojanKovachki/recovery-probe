// The synthetic app the verifier evaluation launches from each checkout: `node server.mjs PORT`.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const API = { '/api/items': ['Alpha', 'Beta', 'Gamma'] }
const port = Number(process.argv[2])

createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  response.setHeader('Cache-Control', 'no-store')
  if (path === '/health') return response.end('ok')
  if (path in API) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify(API[path]))
  }
  const file = path.startsWith('/src/') ? `.${path}` : `./public${path}`
  try {
    const body = await readFile(new URL(file, import.meta.url))
    response.writeHead(200, {
      'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html',
    })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
}).listen(port, '127.0.0.1')
