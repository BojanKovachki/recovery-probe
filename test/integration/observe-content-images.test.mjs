import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { observationConfig } from '../../dist/workflows/observe/config.mjs'
import { runObservation } from '../../dist/workflows/observe/capture.mjs'
import { httpObservationAdapter } from '../../dist/workflows/observe/adapters.mjs'
import { requestSteps } from '../../dist/workflows/observe/requests.mjs'
import { listen } from '../helpers/ports.mjs'

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

let browser, server, origin
before(async () => {
  const html = await readFile(
    new URL('../fixtures/content-images.html', import.meta.url),
  )
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture')
    if (url.pathname === '/image/missing') {
      response.writeHead(404)
      response.end()
    } else if (url.pathname.startsWith('/image/'))
      setTimeout(
        () => {
          response.writeHead(200, { 'content-type': 'image/png' })
          response.end(PNG)
        },
        Number(url.searchParams.get('delay') ?? 0),
      )
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
 * Opens the fixture with `query` and observes its cards for 5 s; by default it renders them once
 * the capture is ready.
 * @param {string} query
 * @param {{ contentImages?: boolean, hooks?: (page: import('playwright').Page) => import('../../dist/workflows/observe/capture.mjs').ObservationHooks }} [options]
 */
async function observe(
  query,
  {
    contentImages = true,
    hooks = (page) => ({ onReady: () => page.evaluate('window.render()') }),
  } = {},
) {
  const page = await browser.newPage()
  await page.goto(`${origin}/?${query}`)
  const config = observationConfig({
    transport: 'http',
    endpoint: origin + '/api/unused',
    regionSelector: '#cards',
    contentSelector: '[data-card]',
    sampleMs: 50,
    observationMs: 5000,
    contentImages,
  })
  // Rendering after the capture starts makes the image delays lower bounds for its timing.
  const report = await runObservation(
    page,
    config,
    httpObservationAdapter(page, config),
    hooks(page),
  )
  await page.close()
  const [interval] = report.intervals
  return { report, interval }
}

test('content counts as loaded only once its <img> and CSS background images have loaded', async () => {
  const { interval } = await observe('')
  const loaded = interval.contentLoaded
  assert.ok(interval.firstContent, 'the card shows')
  assert.ok(loaded, 'the card fully loads')
  assert.equal(loaded.images, 2)
  assert.equal(loaded.failedImages, 0)
  // The card shows 100 ms after the capture starts, and its background image 1200 ms after that.
  assert.ok(loaded.toMs - interval.startMs >= 1300, JSON.stringify(loaded))
  assert.ok(loaded.fromMs > interval.firstContent.toMs)
})

test('a broken image counts as settled, and as failed', async () => {
  const { interval } = await observe('broken')
  assert.equal(interval.contentLoaded?.images, 3)
  assert.equal(interval.contentLoaded?.failedImages, 1)
})

test('content that changes after it fully loaded is timed from when it last did', async () => {
  const { interval } = await observe('late=2000')
  const loaded = interval.contentLoaded
  assert.equal(loaded?.images, 3)
  assert.ok(loaded && loaded.fromMs - interval.startMs >= 2000)
})

test('a lazy image out of view is not waited for', async () => {
  const { interval } = await observe('lazy')
  assert.equal(interval.contentLoaded?.images, 2)
})

test('without contentImages nothing about images is read or recorded', async () => {
  const { report, interval } = await observe('', { contentImages: false })
  assert.equal('contentLoaded' in interval, false)
  assert.equal(
    report.timeline.some((event) => 'contentImages' in event.ui),
    false,
  )
})

test('request steps fail the page’s own requests, and are removed afterwards', async () => {
  /** @type {{ evidence?: import('../../dist/workflows/observe/report.mjs').ObservationRequests, statusAfter?: unknown }} */
  const after = {}
  const { interval } = await observe('', {
    hooks: (page) => {
      const requests = requestSteps(page)
      return {
        async operator() {
          await requests.arm(
            [
              { url: '**/image/a*', fault: 'status', status: 503 },
              { url: '**/image/b*', fault: 'abort' },
            ],
            0,
          )
          await page.evaluate('window.render()')
          await new Promise((resolve) => setTimeout(resolve, 3000))
          after.evidence = await requests.finish()
          after.statusAfter = await page.evaluate(
            'fetch("/image/b").then((response) => response.status)',
          )
        },
      }
    },
  })
  assert.equal(interval.contentLoaded?.images, 2)
  assert.equal(interval.contentLoaded?.failedImages, 2)
  assert.ok(after.evidence?.faults[0].rules?.every((rule) => rule.faulted >= 1))
  assert.equal(after.statusAfter, 200)
})
