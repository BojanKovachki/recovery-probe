import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { observationConfig } from '../../dist/workflows/observe/config.mjs'
import { runObservation } from '../../dist/workflows/observe/capture.mjs'
import { httpObservationAdapter } from '../../dist/workflows/observe/adapters.mjs'
import {
  observationSteps,
  runSteps,
} from '../../dist/workflows/observe/steps.mjs'
import { observationSummary } from '../../dist/workflows/observe/report.mjs'
import { runEvidence, compareRuns } from '../../dist/tools/compare.mjs'

let browser,
  server,
  origin,
  items = []
before(async () => {
  const html = await readFile(
    new URL('../fixtures/library.html', import.meta.url),
  )
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const json = (value) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/api/library' && request.method === 'GET')
      setTimeout(() => json(items), 20)
    else if (
      url.pathname.startsWith('/api/library/') &&
      request.method === 'POST'
    ) {
      const id = url.pathname.split('/').pop()
      if (!items.some((item) => item.id === id))
        items.push({ id, installed: false })
      json({ ok: true })
    } else {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(html)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })
})
after(async () => {
  await browser?.close()
  if (server)
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
})

const config = () =>
  observationConfig({
    transport: 'http',
    endpoint: origin + '/api/library',
    regionSelector: '#installed-region',
    contentSelector: 'li[data-item]',
    rows: {
      selector: 'li[data-item]',
      key: '.name',
      markers: { 'not installed': 'svg.status' },
      unexpected: ['not installed'],
      aliases: { second: 'synthetic-private-item-b' },
    },
    actions: [{ name: 'start', selector: '[data-start]' }],
    sampleMs: 50,
    observationMs: 4000,
  })
const steps = observationSteps([
  { wait: 500 },
  { click: '[data-start="item-b"]', name: 'start-second' },
  { wait: 3000 },
])

async function capture(fixed) {
  items = [{ id: 'ready', installed: true }]
  const page = await browser.newPage()
  try {
    await page.goto(origin + (fixed ? '/?fixed=true' : '/'))
    await page.waitForSelector('li[data-item]')
    const c = config()
    return await runObservation(page, c, httpObservationAdapter(page, c), {
      operator: ({ mark, signal, elapsed }) =>
        runSteps(page, steps, { mark, signal, elapsed }),
    })
  } finally {
    await page.close()
  }
}

test(
  'a row shown in a state the region must not show is reported as UNEXPECTED_ROW_STATE',
  { timeout: 30000 },
  async () => {
    const broken = await capture(false)
    assert.equal(broken.captureComplete, true, JSON.stringify(broken.coverage))
    const findings = broken.findings.filter(
      (f) => f.code === 'UNEXPECTED_ROW_STATE',
    )
    assert.equal(findings.length, 1, JSON.stringify(broken.findings))
    const [finding] = findings
    assert.equal(finding.row, 'second')
    assert.equal(finding.state, 'not installed')
    assert.equal(finding.afterAction.name, 'start')
    assert.ok(finding.afterAction.seenAfterActionMs[1] < 3000)
    assert.ok(finding.samples > 10)
    assert.ok(finding.lastSeenMs > finding.firstSeenMs[1])
    assert.equal(finding.summary, observationSummary(finding))
    assert.match(
      finding.summary,
      /^Row ‘second’ showed not installed, which this region must not show, in \d+ samples from .+ to [\d.]+ s; first seen .+ after action ‘start’\.$/,
    )
    const ready = broken.rows.find((r) => r.row !== 'second')
    assert.equal(ready.lastState, 'none', 'an installed row has no marker')
    assert.ok(
      !JSON.stringify(broken).includes('synthetic-private'),
      'row key text is never stored',
    )

    const fixed = await capture(true)
    assert.equal(fixed.captureComplete, true, JSON.stringify(fixed.coverage))
    assert.deepEqual(
      fixed.findings.filter((f) => f.code === 'UNEXPECTED_ROW_STATE'),
      [],
    )
    const comparison = compareRuns(
      [runEvidence(broken, 'broken')],
      [runEvidence(fixed, 'fixed')],
    )
    // The list is on screen before the capture's first read, so CONTENT_BEFORE_READ stays on both sides.
    assert.equal(
      comparison.changes.find((c) => c.code === 'UNEXPECTED_ROW_STATE').status,
      'GONE',
      comparison.summary,
    )
  },
)
