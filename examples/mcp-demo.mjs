import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { startDemoServer } from './demo-server.mjs'

// Use the packaged executable, including when this example is run by a consumer.
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url)), 'mcp'],
  { stdio: ['pipe', 'pipe', 'inherit'] },
)
const exited = once(child, 'exit')
const lines = createInterface({ input: child.stdout })
const pending = new Map()
let nextId = 0
lines.on('line', (line) => {
  const reply = JSON.parse(line)
  pending.get(reply.id)?.(reply)
})
/** @returns {Promise<any>} */
async function request(method, params = {}) {
  const id = ++nextId
  let timer
  try {
    const reply = await new Promise((resolve, reject) => {
      pending.set(id, resolve)
      timer = setTimeout(() => reject(Error(`Timed out: ${method}`)), 90000)
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      )
    })
    assert.equal(reply.error, undefined, JSON.stringify(reply.error))
    return reply.result
  } finally {
    clearTimeout(timer)
    pending.delete(id)
  }
}
async function call(name, args) {
  const result = await request('tools/call', { name, arguments: args })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  return result.structuredContent
}
const app = await startDemoServer()
try {
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'recovery-probe-demo', version: '1' },
  })
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  )
  const listed = await request('tools/list')
  assert.ok(listed.tools.some(({ name }) => name === 'check_read_recovery'))
  const reads = await call('find_page_reads', {
    url: `${app.url}/fixed`,
    durationMs: 500,
  })
  assert.ok(
    reads.endpoints.some(
      ({ endpoint }) => endpoint === `${app.url}/api/profile`,
    ),
  )
  const check = (page) =>
    call('check_read_recovery', {
      url: `${app.url}/${page}`,
      endpoint: `${app.url}/api/profile`,
      readySelector: '#profile',
      readyText: 'Synthetic Example',
      recovery: 'retry',
      retrySelector: '#retry',
      faults: ['http-error', 'connection-failure', 'invalid-json'],
      timeoutMs: 2000,
    })
  const broken = await check('broken')
  const fixed = await check('fixed')
  assert.equal(broken.ok, false)
  assert.equal(fixed.ok, true)
  for (const result of broken.results) {
    assert.equal(result.outcome, 'fail')
    assert.ok(result.applied > 0)
  }
  for (const result of fixed.results) {
    assert.equal(result.outcome, 'pass')
    assert.ok(result.applied > 0)
  }
  const comparison = await call('compare_reports', {
    before: [broken.report],
    after: [fixed.report],
  })
  assert.equal(comparison.verdict, 'IMPROVED')
  assert.equal(comparison.changes.length, 3)
  assert.ok(comparison.changes.every(({ status }) => status === 'GONE'))
  const evidence = {
    expectedDemonstrationVerified: true,
    broken,
    fixed,
    comparison,
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile(
    'artifacts/mcp-demo.json',
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  child.stdin.end()
  const shutdown = setTimeout(() => child.kill(), 5000)
  await exited
  clearTimeout(shutdown)
  lines.close()
  await app.close()
}
