import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'
import { run as discoverCommand } from '../../dist/cli/discover.mjs'
import { withEvidence } from '../../dist/reports/evidence.mjs'
import { discoverHttp } from '../../dist/workflows/discover/http.mjs'
import { freePort, listen } from '../helpers/ports.mjs'

// A list read once per load: one failure is retried, a second shows "No items" with no error.
const PAGE = `<!doctype html><meta charset="utf-8"><main><h1>Items</h1><section id="content"></section></main><script>
let attempts = 0
async function load() {
  try {
    const response = await fetch('/api/read')
    if (!response.ok) throw Error()
    const { items } = await response.json()
    document.querySelector('#content').innerHTML = '<ul>' + items.map((item) => '<li>' + item + '</li>').join('') + '</ul>'
  } catch {
    if (attempts++ < 1) setTimeout(load, 600)
    else document.querySelector('#content').textContent = 'No items'
  }
}
load()
</script>`

// Small windows keep each run short. One fault kind gives two experiments: http-error-1,
// then every read failing. A healthy load's worst case is 4 s, a faulted one's 5.5 s.
const TIMING = {
  faults: ['http-error'],
  times: 1,
  repeats: 1,
  baselineTimeoutMs: 2000,
  recoveryTimeoutMs: 1500,
  settleMs: 200,
}

async function fixture(t, browserArgs = []) {
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/api/read') {
      res.setHeader('Content-Type', 'application/json')
      setTimeout(() => res.end('{"items":["a","b","c"]}'), 400)
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(PAGE)
  })
  const url = `http://127.0.0.1:${await listen(server)}/`
  // A signal the test sends to its own process must reach only the command, not close this browser.
  const browser = await chromium.launch({
    args: browserArgs,
    handleSIGINT: false,
    handleSIGTERM: false,
  })
  const page = await browser.newPage()
  await page.goto(url)
  await page.locator('li').first().waitFor()
  t.after(async () => {
    await browser.close()
    server.close()
  })
  return { url, page, endpoint: `${url}api/read` }
}

/** The page loads its list after the run: no fault was left behind. */
async function assertHealthy(page) {
  await page.reload()
  await page.locator('li').nth(2).waitFor({ timeout: 5000 })
}

test('a run that reaches its time limit keeps what it completed, lists what it did not run and cleans up', async (t) => {
  const { page, endpoint } = await fixture(t)
  // Calibration's worst case (17.5 s) plus the cleanup reserve (9 s), and a second more. The
  // every-read experiment's worst case (9.5 s) can then never fit after calibration.
  const maxDurationMs = 27500
  const started = Date.now()
  const report = await discoverHttp(page, {
    endpoint,
    ...TIMING,
    maxDurationMs,
  })
  const elapsed = Date.now() - started
  assert.equal(report.stoppedReason, 'BUDGET_EXHAUSTED')
  assert.equal(report.error, 'BUDGET_EXHAUSTED')
  assert.equal(report.readiness.calibrationComplete, true)
  assert.ok(report.notRun.includes('http-error-every-read'))
  for (const id of ['http-error-1', 'http-error-every-read'])
    assert.ok(
      report.findings.some((finding) => finding.id === id) !==
        report.notRun.includes(id),
      `${id} is either a finding or not run`,
    )
  assert.equal(report.budget.maxDurationMs, maxDurationMs)
  assert.ok(report.budget.usedMs <= maxDurationMs, `${report.budget.usedMs}`)
  assert.ok(elapsed <= maxDurationMs + 2000, `${elapsed} ms`)
  assert.equal(report.ok, false)
  // The cleanup reload is reported as it went, and only a verified one as healthy.
  assert.equal(report.finalReset, 'healthy')
  assert.equal(report.cleanupError, undefined)
  const { evidence } = withEvidence(report)
  assert.equal(evidence.complete, false)
  assert.ok(evidence.gaps.some((gap) => gap.includes('BUDGET_EXHAUSTED')))
  await assertHealthy(page)
})

test('without a time limit the run makes exactly the reloads its estimate planned', async (t) => {
  const { page, endpoint } = await fixture(t)
  const progress = []
  const report = await discoverHttp(
    page,
    { endpoint, ...TIMING },
    {
      onProgress: (step) => {
        progress.push(step)
      },
    },
  )
  assert.equal(report.budget, undefined)
  assert.equal(report.stoppedReason, undefined)
  assert.equal(report.estimate.exact, true)
  // Three calibration loads, the screen check, a control and a faulted load per experiment, cleanup.
  assert.equal(report.estimate.plannedLoads, 3 + 1 + 2 * 2 + 1)
  const last = progress.at(-1)
  assert.equal(last.phase, 'finished')
  assert.equal(last.completedLoads, report.estimate.plannedLoads)
  assert.equal(last.worstCaseRemainingMs, 0)
  assert.deepEqual(last.experiments.planned, [
    'http-error-1',
    'http-error-every-read',
  ])
  assert.deepEqual(
    [...new Set(progress.map((step) => step.phase))],
    [
      'starting',
      'calibrating',
      'checking-screen',
      'experimenting',
      'cleaning-up',
      'finished',
    ],
  )
  for (const [i, step] of progress.entries())
    if (i) assert.ok(step.completedLoads >= progress[i - 1].completedLoads)
  await assertHealthy(page)
})

test('an interrupted run stops before its next step, still cleans up, and says so', async (t) => {
  const { page, endpoint } = await fixture(t)
  const abort = new AbortController()
  const report = await discoverHttp(
    page,
    { endpoint, ...TIMING },
    {
      signal: abort.signal,
      onProgress: (step) => {
        if (step.phase === 'experimenting') abort.abort()
      },
    },
  )
  assert.equal(report.stoppedReason, 'INTERRUPTED')
  assert.deepEqual(report.notRun, ['http-error-1', 'http-error-every-read'])
  assert.equal(report.findings.length, 0)
  // Cleanup ignores the interruption.
  assert.equal(report.finalReset, 'healthy')
  assert.equal(report.ok, false)
  await assertHealthy(page)
})

test('the discover command stops on SIGTERM, writes its report and leaves no partial one', async (t) => {
  const port = await freePort()
  const { url, endpoint, page } = await fixture(t, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
  ])
  const directory = await mkdtemp(join(tmpdir(), 'rp-discover-signal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = join(directory, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      cdp: `http://127.0.0.1:${port}`,
      pageUrl: url,
      endpoint,
      ...TIMING,
    }),
  )
  const out = join(directory, 'report')
  const exitCode = process.exitCode
  const handlers = process.listenerCount('SIGTERM')
  const running = discoverCommand({ config, out })
  t.after(() => {
    process.exitCode = exitCode
  })
  // Wait until the run reports it is experimenting, then signal it as a terminal would.
  for (let i = 0; i < 300; i++) {
    const progress = await readFile(join(out, 'progress.json'), 'utf8').then(
      (text) => JSON.parse(text),
      () => undefined,
    )
    if (progress?.phase === 'experimenting') break
    await sleep(100)
  }
  process.emit('SIGTERM')
  await running
  assert.equal(process.exitCode, 2)
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))
  assert.equal(report.stoppedReason, 'INTERRUPTED')
  assert.equal(report.evidence.complete, false)
  const files = await readdir(out)
  assert.ok(!files.includes('report.partial.json'), files.join(', '))
  const progress = JSON.parse(
    await readFile(join(out, 'progress.json'), 'utf8'),
  )
  assert.equal(progress.phase, 'finished')
  assert.equal(progress.stoppedReason, 'INTERRUPTED')
  // The command removed its signal handlers.
  assert.equal(process.listenerCount('SIGTERM'), handlers)
  await assertHealthy(page)
})
