import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoveryProbeTools } from '../../dist/tools/mcp/tools.mjs'
import { startDemoServer } from '../../examples/demo-server.mjs'

const tool = (name) => recoveryProbeTools.find((t) => t.name === name)
const context = { signal: new AbortController().signal }

let server
let directory
const workingDirectory = process.cwd()
before(async () => {
  server = await startDemoServer()
  // Reports are written under the current directory, as for an agent's project.
  directory = await mkdtemp(join(tmpdir(), 'recovery-probe-mcp-'))
  process.chdir(directory)
})
after(async () => {
  process.chdir(workingDirectory)
  await server?.close()
  await rm(directory, { recursive: true, force: true })
})

test('finds the read behind a page', async () => {
  const report = await tool('find_page_reads').run(
    { url: `${server.url}/fixed`, durationMs: 500 },
    context,
  )
  assert.deepEqual(
    report.endpoints.map((e) => e.endpoint),
    [`${server.url}/api/profile`],
  )
})

test('says why the healthy baseline failed', async () => {
  const report = await tool('check_read_recovery').run(
    {
      url: `${server.url}/fixed`,
      endpoint: `${server.url}/api/profile`,
      readySelector: 'p',
      faults: ['http-error'],
      timeoutMs: 300,
    },
    context,
  )
  assert.deepEqual(
    report.results.map(({ code, reason }) => ({ code, reason })),
    [
      {
        code: 'BASELINE_FAILED',
        reason: 'the ready selector matched 2 elements',
      },
    ],
  )
})

test('tells a page that recovers from one that does not', async () => {
  const check = (page) =>
    tool('check_read_recovery').run(
      {
        url: `${server.url}/${page}`,
        endpoint: `${server.url}/api/profile`,
        readySelector: '#profile',
        readyText: 'Synthetic Example',
        faults: ['http-error'],
      },
      context,
    )

  const recovers = await check('automatic')
  assert.equal(recovers.ok, true)
  assert.deepEqual(
    recovers.results.map(({ kind, outcome, applied }) => ({
      kind,
      outcome,
      applied,
    })),
    [{ kind: 'http-error', outcome: 'pass', applied: 1 }],
  )

  const broken = await check('broken')
  assert.equal(broken.ok, false)
  assert.equal(broken.results[0].outcome, 'fail')
  // The broken page shows its error and a Retry button that does nothing.
  assert.equal(broken.results[0].screenText, 'error\nRetry')
  assert.match(broken.limitation, /not proof of overall app health/)
  assert.match(
    await readFile(broken.fixBrief, 'utf8'),
    /Instructions for a coding agent/,
  )
  assert.equal(JSON.parse(await readFile(broken.report, 'utf8')).ok, false)

  // The two reports read as a before and after: the failed read now recovers.
  const comparison = await tool('compare_reports').run(
    { before: [broken.report], after: [recovers.report] },
    context,
  )
  assert.equal(comparison.verdict, 'IMPROVED')
  assert.deepEqual(
    comparison.changes.map(({ status, scope }) => [status, scope]),
    [['GONE', 'http-error']],
  )
})
