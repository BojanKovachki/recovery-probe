import { performance } from 'node:perf_hooks'
import { chromium } from 'playwright'
import { readRegion, summarizeRegion } from '../src/ipc-observation.mjs'
import { observationTable } from '../test/fixtures/observation-table.mjs'

// Diagnostic, not a timing gate: host load and browser versions affect results.
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setContent(observationTable())
  const measurements = { content: [], region: [] }
  for (let i = 0; i < 45; i++) {
    for (const detail of i % 2
      ? ['content', 'region']
      : ['region', 'content']) {
      const start = performance.now()
      const raw = await page.evaluate(readRegion, {
        regionSelector: '#panel',
        contentSelector: '[data-record]',
        detail,
      })
      const received = performance.now()
      summarizeRegion(raw)
      if (i >= 5)
        measurements[detail].push({
          rendererReadMs: raw.rendererReadMs,
          uiRoundTripMs: received - start,
          summarizeMs: performance.now() - received,
          transferBytes: Buffer.byteLength(JSON.stringify(raw)),
        })
    }
  }
  const results = Object.fromEntries(
    Object.entries(measurements).map(([detail, samples]) => [
      detail,
      Object.fromEntries(
        Object.keys(samples[0]).map((key) => {
          const sorted = samples.map((s) => s[key]).sort((a, b) => a - b)
          return [
            key,
            {
              mean: Number(
                (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2),
              ),
              median: Number(((sorted[19] + sorted[20]) / 2).toFixed(2)),
              max: Number(sorted.at(-1).toFixed(2)),
            },
          ]
        }),
      ),
    ]),
  )
  console.log(
    JSON.stringify(
      {
        node: process.versions.node,
        browser: browser.version(),
        rows: 200,
        samplesPerMode: 40,
        results,
        limitation:
          'Synthetic renderer/round-trip measurements only. Excludes IPC snapshots and sampling delays; not a flash-detection guarantee or field-app performance claim.',
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
