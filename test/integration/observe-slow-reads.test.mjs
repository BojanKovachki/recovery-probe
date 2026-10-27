import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { observationConfig } from '../../dist/workflows/observe/config.mjs'
import { runObservation } from '../../dist/workflows/observe/capture.mjs'
import { httpObservationAdapter } from '../../dist/workflows/observe/adapters.mjs'
import { listen } from '../helpers/ports.mjs'

/** @typedef {import('../../dist/workflows/observe/slow-reads/evidence.mjs').SlowReadFinding} SlowReadFinding */

let browser,
  server,
  origin,
  delayMs = 0
before(async () => {
  const html = await readFile(
    new URL('../fixtures/slow-reads.html', import.meta.url),
  )
  server = createServer((request, response) => {
    if (request.url === '/api/contacts')
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(['Ada', 'Grace']))
      }, delayMs)
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

/**
 * Opens the fixture with `query` and observes its contacts read.
 * @param {string} query
 * @param {{ slowReads?: { thresholdMs?: number, bridge?: { global: string } } | null, observationMs?: number, delay?: number }} [options]
 */
async function observe(
  query,
  { slowReads = { thresholdMs: 1500 }, observationMs = 6000, delay = 0 } = {},
) {
  delayMs = delay
  const page = await browser.newPage()
  await page.goto(`${origin}/?${query}`)
  const config = observationConfig({
    transport: 'http',
    endpoint: origin + '/api/contacts',
    regionSelector: '#contacts',
    contentSelector: 'li[data-contact]',
    sampleMs: 100,
    observationMs,
    ...(slowReads ? { slowReads } : {}),
  })
  const report = await runObservation(
    page,
    config,
    httpObservationAdapter(page, config),
  )
  return { report, page }
}

/** @returns {SlowReadFinding[]} */
const slowReadFindings = (report) =>
  report.findings.filter((finding) => finding.code === 'SLOW_READ')

test('slow reads: a renderer busy with short tasks after a fast response', async () => {
  const { report, page } = await observe('busy=2500')
  await page.close()
  assert.equal(report.status, 'complete')
  assert.equal(report.slowReads.renderer.measured, true)
  const [read] = report.slowReads.reads
  assert.equal(read.outcome, 'success')
  assert.equal(read.status, 200)
  assert.ok(read.contentShownMs[0] - read.startedMs >= 2400)
  assert.ok(read.rendererBusyPercent >= 60, `busy ${read.rendererBusyPercent}%`)
  const [finding] = slowReadFindings(report)
  assert.equal(finding.basis, 'RENDERER_BUSY')
  assert.match(
    finding.summary,
    /the renderer’s main thread was busy \d+% of that time/,
  )
})

test('slow reads: a slow response', async () => {
  const { report, page } = await observe('', { delay: 2500 })
  await page.close()
  const [read] = report.slowReads.reads
  assert.ok(read.networkMs >= 2400, `network ${read.networkMs} ms`)
  assert.ok(read.rendererBusyPercent < 50, `busy ${read.rendererBusyPercent}%`)
  assert.equal(slowReadFindings(report)[0].basis, 'NETWORK')
})

test('slow reads: a fast read raises nothing, and a missing bridge is a gap', async () => {
  const { report, page } = await observe('', {
    slowReads: { thresholdMs: 1500, bridge: { global: 'noSuchBridge' } },
    observationMs: 3500,
  })
  await page.close()
  assert.equal(report.slowReads.reads.length, 1)
  assert.equal(report.slowReads.reads[0].slow, false)
  assert.deepEqual(slowReadFindings(report), [])
  assert.equal(report.slowReads.bridge.installed, false)
  assert.ok(report.coverage.gaps.includes('BRIDGE_NOT_INSTRUMENTED'))
})

test('slow reads: requests waiting on a page bridge, and the bridge restored', async () => {
  const { report, page } = await observe('bridge=1&busy=2000', {
    slowReads: { thresholdMs: 1500, bridge: { global: 'fixtureBridge' } },
  })
  const restored = await page.evaluate(
    () =>
      window.fixtureBridge.postMessage === window.originalPost &&
      !('__recoveryProbeBridge' in globalThis),
  )
  await page.close()
  assert.equal(restored, true)
  assert.deepEqual(report.slowReads.bridge, {
    global: 'fixtureBridge',
    installed: true,
    sent: 12,
    answered: 5,
    pendingAtEnd: 7,
  })
  assert.equal(report.slowReads.reads[0].maxBridgePending, 12)
  assert.match(
    slowReadFindings(report)[0].summary,
    /up to 12 bridge requests were waiting\.$/,
  )
})

test('slow reads: a long task does not end the capture', async () => {
  const blocked = await observe('block=5500', { observationMs: 9000 })
  await blocked.page.close()
  assert.equal(blocked.report.status, 'complete')
  assert.ok(blocked.report.slowReads.reads[0].slowestScreenReadMs >= 5000)
  assert.match(
    slowReadFindings(blocked.report)[0].summary,
    /one screen read took \d+\.\d s/,
  )
  // Without slowReads a screen read that takes over 5 s still stops the capture.
  const control = await observe('block=5500', {
    slowReads: null,
    observationMs: 9000,
  })
  await control.page.close()
  assert.equal(control.report.status, 'incomplete')
  assert.match(control.report.error, /UI_SAMPLE_TIMEOUT/)
})
