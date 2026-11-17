import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { observationConfig } from '../../dist/workflows/observe/config.mjs'
import { runObservation } from '../../dist/workflows/observe/capture.mjs'
import { installObserverKit } from '../../dist/workflows/observe/kit.mjs'
import { httpObservationAdapter } from '../../dist/workflows/observe/adapters.mjs'
import { observationSteps } from '../../dist/workflows/observe/steps.mjs'
import { runSteps } from '../../dist/workflows/observe/step-runner.mjs'
import { observationSummary } from '../../dist/workflows/observe/summaries.mjs'
import { runEvidence } from '../../dist/tools/compare/reports.mjs'
import { compareRuns } from '../../dist/tools/compare/run.mjs'
import { listen } from '../helpers/ports.mjs'

/** @typedef {import('../../dist/workflows/observe/progress.mjs').ProgressWentBackFinding} ProgressWentBackFinding */

// compare reads reports back from their JSON files.
const saved = (report) => JSON.parse(JSON.stringify(report))

let browser, server, origin, download
before(async () => {
  const html = await readFile(
    new URL('../fixtures/downloads.html', import.meta.url),
  )
  server = createServer((request, response) => {
    const json = (value) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.url === '/api/downloads') {
      // Each read finds the download a little further along, unless it is paused.
      if (!download.paused)
        download.done = Math.min(download.total, download.done + 0.05)
      setTimeout(() => json(download), 20)
    } else if (request.url === '/api/downloads/pause') {
      download.paused = true
      json({ ok: true })
    } else if (request.url === '/api/downloads/resume')
      setTimeout(() => {
        download.paused = false
        json({ ok: true })
      }, 400)
    else {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(html)
    }
  })
  origin = `http://127.0.0.1:${await listen(server)}`
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

const config = (progress, observationMs = 4000) =>
  observationConfig({
    transport: 'http',
    endpoint: origin + '/api/downloads',
    regionSelector: '#downloads',
    contentSelector: 'li[data-item]',
    rows: {
      selector: 'li[data-item]',
      key: '.name',
      state: '.state',
      states: ['Downloading', 'Paused'],
      progress,
      aliases: { download: 'synthetic-private-download' },
    },
    actions: [{ name: 'resume', selector: '[data-resume]' }],
    sampleMs: 50,
    observationMs,
  })
const steps = observationSteps([
  { wait: 500 },
  { click: '[data-pause]' },
  { wait: 500 },
  { click: '[data-resume]' },
  { wait: 2000 },
])

async function capture(c, { fixed = false, scripted = true } = {}) {
  download = { done: 0.3, total: 1.2, paused: false }
  const page = await browser.newPage()
  try {
    await page.goto(origin + (fixed ? '/?fixed=true' : '/'))
    await page.waitForSelector('li[data-item]')
    return await runObservation(page, c, httpObservationAdapter(page, c), {
      ...(scripted
        ? {
            operator: ({ mark, signal, elapsed }) =>
              runSteps(page, steps, { mark, signal, elapsed }),
          }
        : {}),
    })
  } finally {
    await page.close()
  }
}

const wentBack = (report) =>
  /** @type {ProgressWentBackFinding[]} */ (
    report.findings.filter((f) => f.code === 'PROGRESS_WENT_BACK')
  )

test(
  'a download shown from zero while it resumes is reported as PROGRESS_WENT_BACK',
  { timeout: 60000 },
  async () => {
    const broken = await capture(config('.progress-text'))
    assert.equal(broken.captureComplete, true, JSON.stringify(broken.coverage))
    const findings = wentBack(broken)
    assert.equal(findings.length, 1, JSON.stringify(broken.findings))
    const [finding] = findings
    assert.equal(finding.row, 'download')
    assert.equal(finding.to, 0)
    assert.ok(finding.from > 25, String(finding.from))
    assert.ok(finding.samples > 1)
    assert.ok(finding.recoveredByMs > finding.lastSeenMs)
    assert.equal(finding.afterAction.name, 'resume')
    assert.ok(finding.afterAction.seenAfterActionMs[1] < 1000)
    assert.equal(finding.summary, observationSummary(finding))
    const timeline = JSON.stringify(broken.timeline)
    assert.ok(timeline.includes('"progress":0'), 'samples keep the number')
    assert.ok(
      !JSON.stringify(broken).includes('synthetic-private') &&
        !JSON.stringify(broken).includes('/ 1.2'),
      'row key and progress text are never stored',
    )

    const fixed = await capture(config('.progress-text'), { fixed: true })
    assert.equal(fixed.captureComplete, true, JSON.stringify(fixed.coverage))
    assert.deepEqual(wentBack(fixed), [])
    const comparison = compareRuns(
      [runEvidence(saved(broken), 'broken')],
      [runEvidence(saved(fixed), 'fixed')],
    )
    assert.equal(
      comparison.changes.find((c) => c.code === 'PROGRESS_WENT_BACK').status,
      'GONE',
      comparison.summary,
    )
  },
)

test('progress bars are read as percentages, other elements as their text', async () => {
  const page = await browser.newPage()
  try {
    // 512.125 would read as a thousands group if it reached Node as it is.
    await page.setContent(`
      <progress id="bar" value="512.125" max="1024"></progress>
      <progress id="indeterminate"></progress>
      <div id="aria" role="progressbar" aria-valuenow="30" aria-valuemin="10" aria-valuemax="50"></div>
      <div id="aria-default" role="progressbar" aria-valuenow="45"></div>
      <span id="text"> 0.3 /  1.2 GB </span>`)
    await page.evaluate(installObserverKit, { token: 'progress', actions: [] })
    const ids = ['bar', 'indeterminate', 'aria', 'aria-default', 'text']
    assert.deepEqual(
      await page.evaluate(
        (list) =>
          list.map((id) =>
            globalThis.__recoveryProbeObserve.progressOf(
              document.getElementById(id),
            ),
          ),
        ids,
      ),
      ['50.01%', null, '50.00%', '45.00%', '0.3 / 1.2 GB'],
    )
  } finally {
    await page.close()
  }
})

test(
  'rows.progress that never shows a readable value leaves a coverage gap',
  { timeout: 30000 },
  async () => {
    const report = await capture(config('.missing', 1000), {
      scripted: false,
    })
    assert.equal(report.captureComplete, false)
    assert.ok(
      report.coverage.gaps.includes('PROGRESS_NOT_OBSERVED'),
      JSON.stringify(report.coverage),
    )
  },
)
