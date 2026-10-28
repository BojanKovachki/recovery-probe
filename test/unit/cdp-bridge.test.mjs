import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { startCdpBridge } from '../../dist/targets/cdp-bridge/bridge.mjs'
import { acceptWebSocket } from '../../dist/targets/cdp-bridge/websocket.mjs'
import { listen } from '../helpers/ports.mjs'
import { localRequest } from '../helpers/local-http.mjs'

const appPage = { targetId: 'APP', type: 'page', url: 'https://app.test/' }
const blankPage = { targetId: 'BLANK', type: 'page', url: '' }

/**
 * A device-like DevTools server: the app's page plus a blank WebView that answers
 * nothing, as Android keeps for a WebView without a window.
 */
async function fakeDevice() {
  const received = []
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    const path = new URL(request.url, 'http://device').pathname
    response.writeHead(200, { 'content-type': 'application/json' })
    if (path === '/json/version')
      response.end(
        JSON.stringify({
          Browser: 'Chrome/149',
          webSocketDebuggerUrl: 'ws://device/devtools/browser',
        }),
      )
    else
      response.end(
        JSON.stringify(
          [appPage, blankPage].map(({ targetId, ...target }) => ({
            id: targetId,
            ...target,
            webSocketDebuggerUrl: `ws://device/devtools/page/${targetId}`,
          })),
        ),
      )
  })
  server.on('upgrade', (request, socket) => {
    requests.push(request.url)
    const peer = acceptWebSocket(
      request,
      socket,
      (text) => {
        const message = JSON.parse(text)
        received.push(message)
        const reply = (body) => peer.send(JSON.stringify(body))
        if (message.method === 'Target.setAutoAttach') {
          for (const [target, sessionId] of [
            [appPage, 'S-APP'],
            [blankPage, 'S-BLANK'],
          ])
            reply({
              method: 'Target.attachedToTarget',
              params: {
                sessionId,
                targetInfo: target,
                waitingForDebugger: true,
              },
            })
          reply({ id: message.id, result: {} })
          // Later events for both sessions; only the app's may reach the client.
          reply({ method: 'Page.loadEventFired', sessionId: 'S-BLANK' })
          reply({ method: 'Page.loadEventFired', sessionId: 'S-APP' })
        } else if (message.method === 'Target.getTargets')
          reply({
            id: message.id,
            result: { targetInfos: [appPage, blankPage] },
          })
        else if (message.method === 'Echo')
          reply({ id: message.id, result: { echo: message.params.text } })
        else if (message.method === 'Navigate.app.to.blank')
          reply({
            method: 'Target.targetInfoChanged',
            params: { targetInfo: { ...appPage, url: 'about:blank' } },
          })
        else if (message.sessionId === 'S-BLANK')
          reply({ id: message.id, sessionId: 'S-BLANK', result: {} })
      },
      () => {},
    )
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}

const upgradeHeaders = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version': '13',
}

test('rejects browser origins before opening an upstream connection', async () => {
  await withBridge(async ({ bridge, device }) => {
    for (const Origin of ['https://hostile.example', 'null', '', bridge.url]) {
      assert.equal(
        await localRequest(bridge.url, '/devtools/browser', {
          ...upgradeHeaders,
          Host: new URL(bridge.url).host,
          Origin,
        }),
        403,
      )
    }
    assert.deepEqual(device.requests, [])
  })
})

test('rejects untrusted Host headers on discovery and upgrades', async () => {
  await withBridge(async ({ bridge, device }) => {
    const port = new URL(bridge.url).port
    for (const Host of [
      undefined,
      `rebind.example:${port}`,
      '127.0.0.1:1',
      'localhost',
      `localhost.evil:${port}`,
      `127.0.0.2:${port}`,
      [`127.0.0.1:${port}`, `rebind.example:${port}`],
    ]) {
      for (const path of [
        '/json',
        '/json/list',
        '/json/version/',
        '/devtools/browser',
      ]) {
        const status = await localRequest(bridge.url, path, {
          ...(path.startsWith('/devtools') ? upgradeHeaders : {}),
          ...(Host === undefined ? {} : { Host }),
        })
        // Node may reject malformed HTTP before it reaches our listener.
        assert.ok([400, 403].includes(status), `Host ${Host}: ${status}`)
      }
    }
    assert.deepEqual(device.requests, [])
    for (const host of ['localhost', '127.0.0.1']) {
      assert.equal(
        await localRequest(bridge.url, '/json/version', {
          Host: `${host}:${port}`,
        }),
        200,
      )
      const ws = new WebSocket(`ws://${host}:${port}/devtools/browser`)
      await once(ws, 'open')
      const echoed = once(ws, 'message')
      ws.send(JSON.stringify({ id: 1, method: 'Echo', params: { text: host } }))
      const [event] = await echoed
      assert.equal(JSON.parse(event.data).result.echo, host)
      const closed = once(ws, 'close')
      ws.close()
      await closed
    }
  })
})

/** A client on the bridge's browser endpoint that collects every message. */
async function connect(bridge) {
  const version = await (await fetch(`${bridge.url}/json/version/`)).json()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  const messages = []
  ws.addEventListener('message', (event) =>
    messages.push(JSON.parse(event.data)),
  )
  await once(ws, 'open')
  let id = 1
  return {
    messages,
    ws,
    async call(method, params = {}) {
      const callId = id++
      ws.send(JSON.stringify({ id: callId, method, params }))
      while (!messages.some((m) => m.id === callId))
        await new Promise((resolve) => setTimeout(resolve, 10))
      return messages.find((m) => m.id === callId)
    },
  }
}

async function withBridge(run) {
  const device = await fakeDevice()
  const bridge = await startCdpBridge({ upstream: device.url })
  try {
    await run({ device, bridge })
  } finally {
    await bridge.close()
    await device.close()
  }
}

test('points clients at the bridge and lists only pages that answer', async () => {
  await withBridge(async ({ bridge }) => {
    const version = await (await fetch(`${bridge.url}/json/version`)).json()
    assert.equal(version.Browser, 'Chrome/149')
    assert.equal(
      version.webSocketDebuggerUrl,
      `${bridge.url.replace('http', 'ws')}/devtools/browser`,
    )
    const list = await (await fetch(`${bridge.url}/json/list`)).json()
    assert.deepEqual(list, [
      { id: 'APP', type: 'page', url: 'https://app.test/' },
    ])
  })
})

test('hides blank WebViews from a client and lets them run', async () => {
  await withBridge(async ({ device, bridge }) => {
    const client = await connect(bridge)
    await client.call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(
      client.messages
        .filter((m) => m.method)
        .map((m) => [m.method, m.params?.sessionId ?? m.sessionId]),
      [
        ['Target.attachedToTarget', 'S-APP'],
        ['Page.loadEventFired', 'S-APP'],
      ],
    )
    // The bridge released the blank page instead of leaving it paused.
    assert.ok(
      device.received.some(
        (m) =>
          m.method === 'Runtime.runIfWaitingForDebugger' &&
          m.sessionId === 'S-BLANK',
      ),
    )
    // Its reply to that never reaches the client.
    assert.ok(!client.messages.some((m) => m.sessionId === 'S-BLANK'))

    const targets = await client.call('Target.getTargets')
    assert.deepEqual(
      targets.result.targetInfos.map((t) => t.targetId),
      ['APP'],
    )
    client.ws.close()
  })
})

// A page the client already holds must keep its events, or it waits on them forever.
test('keeps a page it showed even when it turns blank', async () => {
  await withBridge(async ({ bridge }) => {
    const client = await connect(bridge)
    await client.call('Target.getTargets')
    client.ws.send(JSON.stringify({ id: 99, method: 'Navigate.app.to.blank' }))
    while (
      !client.messages.some((m) => m.method === 'Target.targetInfoChanged')
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    client.ws.close()
  })
})

test('carries messages of every size both ways', async () => {
  await withBridge(async ({ bridge }) => {
    const client = await connect(bridge)
    for (const size of [10, 1_000, 100_000]) {
      const text = 'x'.repeat(size)
      const reply = await client.call('Echo', { text })
      assert.equal(reply.result.echo.length, size)
    }
    client.ws.close()
  })
})
