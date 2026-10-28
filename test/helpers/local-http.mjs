import { request } from 'node:http'

/** Sends explicit headers to a loopback server, including WebSocket upgrades. */
export function localRequest(url, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const rawHeaders = Object.entries(headers).flatMap(([name, value]) =>
      [value].flat().flatMap((item) => [name, item]),
    )
    const req = request(new URL(path, url), {
      headers: rawHeaders,
      setHost: false,
    })
    req.on('error', reject)
    req.on('response', (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    req.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode)
    })
    req.setTimeout(2000, () => req.destroy(new Error('Request timed out')))
    req.end()
  })
}
