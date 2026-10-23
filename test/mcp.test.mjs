import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { serveMcp } from '../dist/mcp-server.mjs'

/** A client that sends JSON-RPC lines and resolves replies by id. */
function client(input, output) {
  const waiting = new Map()
  const unanswered = []
  createInterface({ input: output }).on('line', (line) => {
    const message = JSON.parse(line)
    const id = Array.isArray(message) ? 'batch' : message.id
    const resolve = waiting.get(id)
    if (resolve) {
      waiting.delete(id)
      resolve(message)
    } else unanswered.push(message)
  })
  let next = 1
  return {
    unanswered,
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    request(method, params, id = next++) {
      const reply = new Promise((resolve) => waiting.set(id, resolve))
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return reply
    },
    batch(messages) {
      const reply = new Promise((resolve) => waiting.set('batch', resolve))
      input.write(`${JSON.stringify(messages)}\n`)
      return reply
    },
  }
}

/** Starts `recovery-probe mcp` as an agent would. */
function startServer({ cwd } = {}) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url)),
      'mcp',
    ],
    { cwd, stdio: ['pipe', 'pipe', 'inherit'] },
  )
  return { child, ...client(child.stdin, child.stdout) }
}

async function call(server, name, args = {}) {
  const { result } = await server.request('tools/call', {
    name,
    arguments: args,
  })
  return result
}

test('answers the MCP handshake and lists its tools', async () => {
  const server = startServer()
  try {
    const { result } = await server.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    assert.equal(result.protocolVersion, '2025-03-26')
    assert.equal(result.serverInfo.name, 'recovery-probe')
    assert.match(result.instructions, /not passes/)
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    const { result: listed } = await server.request('tools/list')
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        'find_page_reads',
        'check_read_recovery',
        'start_network_faults',
        'set_network_faults',
        'network_fault_summary',
        'stop_network_faults',
        'find_suspects',
        'compare_reports',
        'verify_change',
        'run_recovery_probe',
      ],
    )
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name)
      assert.ok(tool.description.length > 40, tool.name)
    }

    assert.deepEqual((await server.request('ping')).result, {})
    assert.equal((await server.request('resources/list')).error.code, -32601)
    assert.equal(
      (await server.request('tools/call', { name: 'missing' })).error.code,
      -32602,
    )
    // Notifications get no reply.
    assert.equal(server.unanswered.length, 0)
  } finally {
    server.child.stdin.end()
    await new Promise((resolve) => server.child.once('exit', resolve))
  }
})

test('offers its newest protocol version to a client that asks for another', async () => {
  const server = startServer()
  try {
    const { result } = await server.request('initialize', {
      protocolVersion: '1999-01-01',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    assert.equal(result.protocolVersion, '2025-06-18')
  } finally {
    server.child.stdin.end()
  }
})

test('reports invalid arguments as a tool error the agent can read', async () => {
  const server = startServer()
  try {
    const result = await call(server, 'check_read_recovery', {
      url: 'http://127.0.0.1:1',
    })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /endpoint must be a non-empty string/)
    const unknown = await call(server, 'run_recovery_probe', {
      args: ['repair'],
    })
    assert.equal(unknown.isError, true)
    assert.match(unknown.content[0].text, /must be one of observe/)
    const forward = await call(server, 'run_recovery_probe', {
      args: ['android', '--package', 'com.example.app'],
    })
    assert.equal(forward.isError, true)
    assert.match(forward.content[0].text, /Only android --list/)
  } finally {
    server.child.stdin.end()
  }
})

test('runs a Recovery Probe command for the agent', async () => {
  const server = startServer()
  try {
    const result = await call(server, 'run_recovery_probe', {
      args: ['observe', '--help'],
    })
    assert.equal(result.isError, false)
    assert.equal(result.structuredContent.exitCode, 0)
    assert.match(result.structuredContent.stdout, /recovery-probe observe/)
  } finally {
    server.child.stdin.end()
  }
})

test('finds suspects in the code the agent names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-mcp-suspects-'))
  const server = startServer({ cwd: root })
  try {
    await mkdir(join(root, 'src'))
    await writeFile(
      join(root, 'src', 'store.ts'),
      'export const rows = async () => (await load()) ?? []\n',
    )
    await writeFile(join(root, 'src', 'view.ts'), 'export const a = 1\n')
    const result = await call(server, 'find_suspects', { paths: ['src'] })
    assert.equal(result.isError, false)
    const { scanned, found, suspects } = result.structuredContent
    assert.equal(scanned, 2)
    assert.equal(found, 1)
    assert.equal(suspects[0].file, 'src/store.ts')
    assert.equal(suspects[0].pattern, 'UNKNOWN_AS_EMPTY')
    assert.equal(suspects[0].read, 'load()')
    const invalid = await call(server, 'find_suspects', { paths: 'src' })
    assert.equal(invalid.isError, true)
    assert.match(invalid.content[0].text, /paths must be a list/)
  } finally {
    server.child.stdin.end()
    await new Promise((resolve) => server.child.once('exit', resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('compares reports from before and after a change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-mcp-compare-'))
  const server = startServer({ cwd: root })
  const action = (findings) => ({
    schemaVersion: 1,
    mode: 'IPC action check',
    channel: 'contacts:add',
    findings,
    ok: true,
  })
  try {
    await writeFile(
      join(root, 'before.json'),
      JSON.stringify(
        action([
          { classification: 'SILENT_FAILURE', kind: 'suspected-defect' },
        ]),
      ),
    )
    await writeFile(
      join(root, 'after.json'),
      JSON.stringify(
        action([{ classification: 'FEEDBACK_SHOWN', kind: 'observation' }]),
      ),
    )
    const result = await call(server, 'compare_reports', {
      before: ['before.json'],
      after: ['after.json'],
      afterLabel: 'branch',
    })
    assert.equal(result.isError, false)
    const { verdict, changes, markdown } = result.structuredContent
    assert.equal(verdict, 'IMPROVED')
    assert.equal(changes[0].status, 'GONE')
    assert.match(markdown, /SILENT_FAILURE/)
    assert.match(markdown, /branch/)
    const missing = await call(server, 'compare_reports', {
      before: [],
      after: ['after.json'],
    })
    assert.equal(missing.isError, true)
    assert.match(missing.content[0].text, /before must be a non-empty list/)
  } finally {
    server.child.stdin.end()
    await new Promise((resolve) => server.child.once('exit', resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('drives network faults through the tools', async () => {
  const server = startServer()
  try {
    const started = (await call(server, 'start_network_faults'))
      .structuredContent
    assert.equal(started.env.HTTPS_PROXY, started.url)
    await call(server, 'set_network_faults', {
      rules: [{ host: 'api.example.test', fault: 'refuse' }],
    })
    const status = await new Promise((resolve) => {
      const port = Number(new URL(started.url).port)
      request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: 'api.example.test:443',
      })
        .on('connect', (res, socket) => {
          socket.destroy()
          resolve(res.statusCode)
        })
        .end()
    })
    assert.equal(status, 502)
    const summary = (await call(server, 'network_fault_summary'))
      .structuredContent
    assert.equal(summary.rules[0].applied, 1)
    assert.deepEqual(
      (await call(server, 'set_network_faults', { restore: true }))
        .structuredContent,
      { armed: [] },
    )
    const stopped = (await call(server, 'stop_network_faults'))
      .structuredContent
    assert.equal(stopped.stopped, true)
    assert.equal(stopped.connections, 1)
  } finally {
    server.child.stdin.end()
  }
})

test('cancels a running tool and answers batches', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let cancelled = false
  const served = serveMcp(
    {
      name: 'test',
      version: '0',
      tools: [
        {
          name: 'wait',
          description: 'Waits until cancelled.',
          inputSchema: { type: 'object' },
          run: (_args, { signal }) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => {
                cancelled = true
                reject(Error('cancelled'))
              }),
            ),
        },
        {
          name: 'fail',
          description: 'Always fails.',
          inputSchema: { type: 'object' },
          run: async () => {
            throw Error('it broke')
          },
        },
      ],
    },
    input,
    output,
  )
  const session = client(input, output)
  const waiting = session.request('tools/call', { name: 'wait' }, 'w')
  session.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 'w' },
  })
  assert.equal((await waiting).result.isError, true)
  assert.ok(cancelled)

  const replies = await session.batch([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fail' },
    },
  ])
  assert.deepEqual(
    replies.map((reply) => reply.id),
    [1, 2],
  )
  assert.equal(replies[1].result.content[0].text, 'it broke')

  input.end()
  await served
})
