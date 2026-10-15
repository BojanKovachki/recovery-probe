import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { discoverHttp } from '../src/http-discover.mjs'

async function withFixture(mode, exercise) {
  let loads = 0
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/api/items') {
      res.setHeader('Content-Type', 'application/json')
      res.end('{}')
      return
    }
    if (req.url !== '/') {
      res.writeHead(404)
      res.end()
      return
    }
    const count =
      mode === 'empty' ? 0 : mode === 'unstable' ? 2 + (++loads % 2) : 3
    res.setHeader('Content-Type', 'text/html')
    res.end(`<!doctype html><main><h1>Catalog</h1><section id="content"></section></main><script>
      fetch('/api/items').then(r => { if (!r.ok) throw Error(); return r.json(); })
        .then(() => setTimeout(() => {
          document.querySelector('#content').innerHTML = '<button><img alt="Card"></button>'.repeat(${count});
        }, 500)).catch(() => {});
    </script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(base)
    await exercise(page, {
      endpoint: base + '/api/items',
      faults: ['http-error'],
      times: 1,
      repeats: 1,
      baselineTimeoutMs: 1200,
      recoveryTimeoutMs: 600,
      settleMs: 200,
    })
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

test(
  'HTTP discovery calibrates delayed content before classifying its loss',
  { timeout: 20000 },
  async () => {
    await withFixture('delayed', async (page, config) => {
      const report = await discoverHttp(page, config)
      assert.equal(report.error, undefined, JSON.stringify(report))
      assert.equal(report.baselines.length, 3)
      for (const baseline of report.baselines) {
        assert.equal(
          baseline.ui.images,
          3,
          'an intermediate empty shell is not the baseline',
        )
        assert.ok(baseline.elapsedMs >= config.baselineTimeoutMs)
        assert.ok(baseline.timeline.some((event) => event.ui.images === 0))
      }
      assert.equal(report.readiness.calibrationComplete, true)
      assert.equal(report.findings[0].classification, 'CONTENT_LOSS')
      assert.equal(report.results[0].snapshot.injected, 1)
      assert.equal(report.results[0].observation.before.images, 3)
      assert.equal(report.results[0].observation.after.images, 0)
      assert.equal(report.finalReset, 'healthy')
    })
  },
)

test(
  'HTTP discovery accepts a genuinely empty selected region after successful reads',
  { timeout: 20000 },
  async () => {
    await withFixture('empty', async (page, config) => {
      const report = await discoverHttp(page, {
        ...config,
        regionSelector: '#content',
      })
      assert.equal(report.error, undefined, JSON.stringify(report))
      assert.ok(
        report.baselines.every(
          (baseline) => baseline.ready && baseline.ui.textLength === 0,
        ),
      )
      assert.equal(report.results[0].snapshot.injected, 1)
      assert.notEqual(report.findings[0].kind, 'suspected-defect')
      assert.equal(report.finalReset, 'healthy')
    })
  },
)

test(
  'HTTP discovery does not trust matching intermediate shells with different final content',
  { timeout: 20000 },
  async () => {
    await withFixture('unstable', async (page, config) => {
      const report = await discoverHttp(page, config)
      assert.equal(report.error, 'BASELINE_UNSTABLE')
      assert.equal(report.baselines.length, 3)
      assert.equal(report.readiness.calibrationComplete, false)
      assert.equal(report.results.length, 0)
      assert.equal(report.finalReset, 'not-verified')
      assert.equal(report.ok, false)
      assert.ok(
        report.baselines.every((baseline) => baseline.snapshot.injected === 0),
      )
    })
  },
)
