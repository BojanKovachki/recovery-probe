import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startNetworkFaultProxy,
  validateNetworkRules,
  hostMatches,
  connectNetworkFaults,
} from '../../dist/net-fault.mjs'

// The proxy never reads what goes through a tunnel, so an echo server stands in
// for the HTTPS server behind it.
let echo
let echoPort
before(async () => {
  echo = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.pipe(socket)
  })
  echo.listen(0, '127.0.0.1')
  await once(echo, 'listening')
  echoPort = echo.address().port
})
after(() => echo.close())

/** Opens a tunnel; resolves with the proxy's status and the socket, or `timeout`. */
function tunnel(proxy, host = '127.0.0.1', port = echoPort, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const req = request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
    })
    const timer = setTimeout(() => {
      req.destroy()
      resolve({ status: 'timeout' })
    }, timeoutMs)
    req.on('connect', (res, socket) => {
      clearTimeout(timer)
      socket.on('error', () => {})
      resolve({ status: res.statusCode, socket, ms: Date.now() - started })
    })
    req.on('error', () => {
      clearTimeout(timer)
      resolve({ status: 'error' })
    })
    req.end()
  })
}

/** Sends a line through a tunnel; resolves with the echo or how the tunnel ended. */
function roundTrip(socket) {
  return new Promise((resolve) => {
    socket.once('data', (data) => resolve(data.toString()))
    socket.once('close', () => resolve('closed'))
    socket.write('ping')
  })
}

async function withProxy(rules, run) {
  const proxy = await startNetworkFaultProxy({ rules })
  try {
    await run(proxy)
  } finally {
    await proxy.close()
  }
}

test('passes a connection through when no rule applies', async () => {
  await withProxy([{ host: 'localhost', fault: 'refuse' }], async (proxy) => {
    const { status, socket } = await tunnel(proxy)
    assert.equal(status, 200)
    assert.equal(await roundTrip(socket), 'ping')
    assert.deepEqual(
      proxy.events().map(({ host, outcome }) => ({ host, outcome })),
      [{ host: '127.0.0.1', outcome: 'passed' }],
    )
  })
})

test('refuses a matching connection', async () => {
  await withProxy([{ host: '127.0.0.1', fault: 'refuse' }], async (proxy) => {
    assert.equal((await tunnel(proxy)).status, 502)
    assert.equal(proxy.events()[0].outcome, 'refuse')
    assert.equal(proxy.events()[0].rule, 0)
    assert.deepEqual(proxy.assertApplied().rules, [
      { host: '127.0.0.1', fault: 'refuse', matching: 1, applied: 1 },
    ])
  })
})

test('resets a connection once the client starts its handshake', async () => {
  await withProxy([{ host: '127.0.0.1', fault: 'reset' }], async (proxy) => {
    const { status, socket } = await tunnel(proxy)
    assert.equal(status, 200)
    assert.equal(await roundTrip(socket), 'closed')
  })
})

test('stalls a connection until the client gives up', async () => {
  await withProxy([{ host: '127.0.0.1', fault: 'stall' }], async (proxy) => {
    assert.equal(
      (await tunnel(proxy, undefined, undefined, 300)).status,
      'timeout',
    )
    assert.equal(proxy.events()[0].outcome, 'stall')
  })
})

test('delays a connection before it goes through', async () => {
  await withProxy(
    [{ host: '127.0.0.1', fault: 'delay', delayMs: 300 }],
    async (proxy) => {
      const { status, socket, ms } = await tunnel(proxy)
      assert.equal(status, 200)
      assert.ok(ms >= 280, `went through after ${ms} ms`)
      assert.equal(await roundTrip(socket), 'ping')
    },
  )
})

test('faults only as many connections as its count', async () => {
  await withProxy(
    [{ host: '127.0.0.1', fault: 'refuse', count: 1 }],
    async (proxy) => {
      assert.equal((await tunnel(proxy)).status, 502)
      assert.equal((await tunnel(proxy)).status, 200)
      assert.deepEqual(proxy.summary().rules[0], {
        host: '127.0.0.1',
        fault: 'refuse',
        matching: 2,
        applied: 1,
      })
    },
  )
})

test('applies a rule only inside its window', async () => {
  await withProxy(
    [{ host: '127.0.0.1', fault: 'refuse', fromMs: 300 }],
    async (proxy) => {
      assert.equal((await tunnel(proxy)).status, 200)
      await delay(400)
      assert.equal((await tunnel(proxy)).status, 502)
    },
  )
  await withProxy(
    [{ host: '127.0.0.1', fault: 'refuse', untilMs: 300 }],
    async (proxy) => {
      assert.equal((await tunnel(proxy)).status, 502)
      await delay(400)
      assert.equal((await tunnel(proxy)).status, 200)
    },
  )
})

// Clients keep connections open and reuse them, so a fault on new connections
// alone would never reach them.
test('drops the open connections to a host', async () => {
  await withProxy([{ host: 'localhost', fault: 'refuse' }], async (proxy) => {
    const { socket } = await tunnel(proxy)
    const closed = once(socket, 'close')
    assert.equal(proxy.dropOpen('localhost'), 0)
    assert.equal(proxy.dropOpen('127.0.0.1'), 1)
    await closed
  })
})

test('a rule drops the open connections when it starts to apply', async () => {
  await withProxy(undefined, async (proxy) => {
    const { socket } = await tunnel(proxy)
    const closed = once(socket, 'close')
    proxy.arm([{ host: '127.0.0.1', fault: 'refuse', dropOpen: true }])
    await closed
    assert.equal((await tunnel(proxy)).status, 502)
  })
})

test('reports a host it cannot reach', async () => {
  const unused = net.createServer().listen(0, '127.0.0.1')
  await once(unused, 'listening')
  const closedPort = unused.address().port
  unused.close()
  await withProxy(undefined, async (proxy) => {
    assert.equal((await tunnel(proxy, '127.0.0.1', closedPort)).status, 502)
    assert.equal(proxy.events()[0].outcome, 'upstream-error')
  })
})

test('reports a rule that faulted no connection', async () => {
  await withProxy([{ host: 'localhost', fault: 'refuse' }], async (proxy) => {
    await tunnel(proxy)
    assert.throws(() => proxy.assertApplied(), { code: 'FAULT_NOT_TRIGGERED' })
  })
})

test('stops faulting once disarmed', async () => {
  await withProxy([{ host: '127.0.0.1', fault: 'refuse' }], async (proxy) => {
    proxy.disarm()
    assert.equal((await tunnel(proxy)).status, 200)
  })
})

test('routes a client through the proxy with HTTPS_PROXY', async () => {
  await withProxy(undefined, async (proxy) => {
    assert.deepEqual(proxy.env(), {
      HTTPS_PROXY: proxy.url,
      NO_PROXY: 'localhost,127.0.0.1,::1',
    })
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  })
})

test('matches a host exactly, by subdomain or every host', () => {
  assert.ok(hostMatches('api.example.com', 'API.example.com'))
  assert.ok(!hostMatches('api.example.com', 'cdn.example.com'))
  assert.ok(hostMatches('*.example.com', 'cdn.example.com'))
  assert.ok(!hostMatches('*.example.com', 'example.com'))
  assert.ok(!hostMatches('*.example.com', 'example.com.evil.test'))
  assert.ok(hostMatches('*', 'anything.test'))
})

test('rejects rules it cannot apply', () => {
  for (const rules of [
    [],
    [{ fault: 'refuse' }],
    [{ host: 'a.test', fault: 'drop' }],
    [{ host: 'a.test', fault: 'delay' }],
    [{ host: 'a.test', fault: 'refuse', count: 0 }],
    [{ host: 'a.test', fault: 'refuse', fromMs: -1 }],
    [{ host: 'a.test', fault: 'refuse', fromMs: 500, untilMs: 500 }],
  ])
    assert.throws(() => validateNetworkRules(rules), TypeError)
  assert.deepEqual(
    validateNetworkRules([{ host: ' API.Example.com ', fault: 'stall' }]),
    [{ host: 'api.example.com', fault: 'stall' }],
  )
})

test('can start its rules on the first connection', async () => {
  const proxy = await startNetworkFaultProxy({
    rules: [{ host: '127.0.0.1', fault: 'refuse', untilMs: 300 }],
    armOnFirstConnection: true,
  })
  try {
    // A window counted from the start would be over by now.
    await delay(400)
    assert.equal((await tunnel(proxy)).status, 502)
  } finally {
    await proxy.close()
  }
})

/** Runs `net` for 1.5 s; `connect` gets its port once it is listening. */
async function runCli(rules, connect) {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-probe-net-'))
  const rulesPath = join(directory, 'rules.json')
  await writeFile(rulesPath, JSON.stringify({ rules }))
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../bin/recovery-probe.mjs', import.meta.url)),
      'net',
      '--rules',
      rulesPath,
      '--duration',
      '1500',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (data) => (output += data))
  child.stderr.on('data', (data) => (output += data))
  while (!/on http:\/\/127\.0\.0\.1:(\d+)/.test(output)) await delay(50)
  const port = Number(output.match(/on http:\/\/127\.0\.0\.1:(\d+)/)[1])
  await connect({ port })
  const [code] = await once(child, 'exit')
  return { code, output }
}

test('the net command reports the faults it applied', async () => {
  const { code, output } = await runCli(
    [{ host: '127.0.0.1', fault: 'refuse' }],
    async (proxy) => assert.equal((await tunnel(proxy)).status, 502),
  )
  assert.equal(code, 0)
  assert.match(output, /rule 1: refuse 127\.0\.0\.1 faulted 1 of 1 matching/)
})

test('the net command exits 2 when a rule faulted nothing', async () => {
  const { code, output } = await runCli(
    [{ host: 'unused.example', fault: 'refuse' }],
    async (proxy) => assert.equal((await tunnel(proxy)).status, 200),
  )
  assert.equal(code, 2)
  assert.match(output, /FAULT_NOT_TRIGGERED/)
})

// The first connection arms the rules, so it is not one of those open before them.
test('a rule drops only the connections opened before it started', async () => {
  const proxy = await startNetworkFaultProxy({
    rules: [
      { host: '127.0.0.1', fault: 'delay', delayMs: 100, dropOpen: true },
    ],
    armOnFirstConnection: true,
  })
  try {
    const { status, socket } = await tunnel(proxy)
    assert.equal(status, 200)
    assert.equal(await roundTrip(socket), 'ping')
  } finally {
    await proxy.close()
  }
})

test('can be controlled from another process', async () => {
  const proxy = await startNetworkFaultProxy({ control: true })
  try {
    const control = connectNetworkFaults(proxy.url)
    await control.arm([{ host: '127.0.0.1', fault: 'refuse' }])
    assert.equal((await tunnel(proxy)).status, 502)
    assert.deepEqual((await control.summary()).rules, [
      { host: '127.0.0.1', fault: 'refuse', matching: 1, applied: 1 },
    ])
    await control.disarm()
    const { socket } = await tunnel(proxy)
    const closed = once(socket, 'close')
    assert.equal(await control.dropOpen('127.0.0.1'), 1)
    await closed
    await assert.rejects(
      control.arm([{ host: '127.0.0.1', fault: 'drop' }]),
      /arm failed \(400\): rules\[0\]\.fault/,
    )
  } finally {
    await proxy.close()
  }
})

// A web page can send a simple request to a loopback port, but not this header.
test('answers control requests only with its header', async () => {
  const proxy = await startNetworkFaultProxy({ control: true })
  try {
    const plain = await fetch(`${proxy.url}/recovery-probe/network/disarm`, {
      method: 'POST',
    })
    assert.equal(plain.status, 403)
    const unknown = await fetch(`${proxy.url}/recovery-probe/network/other`, {
      method: 'POST',
      headers: { 'x-recovery-probe': 'network' },
    })
    assert.equal(unknown.status, 404)
  } finally {
    await proxy.close()
  }
  const closed = await startNetworkFaultProxy()
  try {
    const response = await fetch(
      `${closed.url}/recovery-probe/network/summary`,
      {
        headers: { 'x-recovery-probe': 'network' },
      },
    )
    assert.equal(response.status, 501)
  } finally {
    await closed.close()
  }
})

test('controls only a loopback proxy', () => {
  assert.throws(() => connectNetworkFaults('http://192.0.2.1:8899'), /loopback/)
})
