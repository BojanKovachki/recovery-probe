import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { runDiscovery } from '../../dist/workflows/discover/run.mjs'
import { listen } from '../helpers/ports.mjs'

/** @typedef {import('../../dist/workflows/discover/types.mjs').ReadSnapshot} ReadSnapshot */

// A page whose list shows `items(load)` entries on each reload.
async function withPage(items, exercise) {
  let load = 0
  const server = createServer((req, res) => {
    const count = items(++load)
    res.setHeader('Content-Type', 'text/html')
    res.end(
      `<!doctype html><main>${count ? `<ul>${'<li>Item</li>'.repeat(count)}</ul>` : '<p>No items</p>'}</main>`,
    )
  })
  const port = await listen(server)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}`)
    await exercise(page)
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

// Counters for one read that always succeeds; `pending` keeps it from settling.
function fakeSession({ pending = 0 } = {}) {
  let plan = {}
  return {
    plans: [],
    async begin(next) {
      plan = next
      this.plans.push(next)
    },
    snapshot() {
      const injected = plan.fault ? plan.times : 0
      return {
        injected,
        injectedAt: injected ? Date.now() : null,
        successfulAfterFault: injected ? 1 : 0,
        channels: {
          read: { realCalls: 1, successes: 1, errors: 0, pending },
        },
      }
    },
    async stop() {},
  }
}

/** @returns {import('../../dist/workflows/discover/types.mjs').DiscoveryResult<string, ReadSnapshot>} */
const report = () => ({
  baselines: [],
  results: [],
  findings: [],
  finalReset: 'not-verified',
  ok: false,
  readiness: { calibrationComplete: false },
})
/** @returns {import('../../dist/workflows/discover/types.mjs').DiscoverySetup<string, ReadSnapshot>} */
const setup = (page, session) => ({
  page,
  session,
  read: 'read',
  dependencies: [],
  readKind: 'channel',
  readFailed: 'REAL_HANDLER_FAILED',
  experiments: [{ fault: 'rejection', times: 1 }],
  verification: 'Rerun it.',
})
const timing = {
  baselineTimeoutMs: 600,
  observationMs: 600,
  settleMs: 200,
  repeats: 2,
  restoreWindow: false,
}

test(
  'repeats that disagree are an unstable, low-confidence finding',
  { timeout: 30000 },
  async () => {
    // Load 1 opens the page and 2–4 calibrate; then control, fault, control, fault, cleanup.
    await withPage(
      (load) => (load === 6 ? 0 : 3),
      async (page) => {
        const result = report()
        await runDiscovery(setup(page, fakeSession()), timing, result)
        assert.equal(result.error, undefined, JSON.stringify(result.error))
        assert.deepEqual(
          result.results.map((r) => r.interpretation.classification),
          ['SILENT_EMPTY', 'RECOVERED'],
        )
        const [finding] = result.findings
        assert.equal(finding.classification, 'UNSTABLE')
        assert.equal(finding.kind, 'inconclusive')
        assert.equal(finding.confidence, 'low')
        assert.equal(finding.repeatConfirmed, false)
        assert.equal(finding.verification, 'Rerun it.')
        assert.equal(result.finalReset, 'healthy')
      },
    )
  },
)

test(
  'a baseline that never settles stops the run before any fault',
  { timeout: 30000 },
  async () => {
    await withPage(
      () => 3,
      async (page) => {
        const session = fakeSession({ pending: 1 })
        const result = report()
        await runDiscovery(setup(page, session), timing, result)
        assert.equal(result.error, 'BASELINE_NOT_HEALTHY')
        assert.equal(result.baselines.length, 1)
        assert.equal(result.readiness.calibrationComplete, false)
        assert.ok(session.plans.every((plan) => !plan.fault))
        assert.equal(result.ok, false)
      },
    )
  },
)

test(
  'later calls are failed one by one only when the transport can let calls through',
  { timeout: 30000 },
  async () => {
    await withPage(
      () => 3,
      async (page) => {
        const session = fakeSession()
        const snapshot = session.snapshot.bind(session)
        session.snapshot = () => {
          const s = snapshot()
          s.channels.read.realCalls = 2
          return s
        }
        const result = report()
        await runDiscovery(
          { ...setup(page, session), laterCallFault: 'rejection' },
          { ...timing, repeats: 1 },
          result,
        )
        assert.deepEqual(
          result.findings.map((f) => f.id),
          ['rejection-1', 'rejection-1-call2'],
        )
        assert.ok(session.plans.some((plan) => plan.skip === 1))
        const without = report()
        await runDiscovery(
          setup(page, session),
          { ...timing, repeats: 1 },
          without,
        )
        assert.deepEqual(
          without.findings.map((f) => f.id),
          ['rejection-1'],
        )
        assert.match(without.readiness.callsGap, /cannot let calls through/)
      },
    )
  },
)
