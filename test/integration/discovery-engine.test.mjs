import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { runDiscovery } from '../../dist/workflows/discover/run.mjs'
import { listen } from '../helpers/ports.mjs'

/** @typedef {import('../../dist/workflows/discover/types.mjs').ReadSnapshot} ReadSnapshot */

/**
 * A page whose list shows `items(load)` entries on each reload, followed by `script(load)`.
 * @param {(load: number) => number} items
 * @param {(page: import('playwright').Page) => Promise<void>} exercise
 * @param {(load: number) => string} [script]
 */
async function withPage(items, exercise, script = () => '') {
  let load = 0
  const server = createServer((req, res) => {
    const count = items(++load)
    res.setHeader('Content-Type', 'text/html')
    res.end(
      `<!doctype html><main>${count ? `<ul>${'<li>Item</li>'.repeat(count)}</ul>` : '<p>No items</p>'}</main>${script(load)}`,
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

// Counters for one read that succeeds unless faulted; the app tries it `calls` times
// per load, and `pending` keeps it from settling.
function fakeSession({ pending = 0, calls = Infinity } = {}) {
  let plan = {}
  return {
    plans: [],
    async begin(next) {
      plan = next
      this.plans.push(next)
    },
    snapshot() {
      const injected = plan.fault ? Math.min(plan.times, calls) : 0
      return {
        injected,
        injectedAt: injected ? Date.now() : null,
        successfulAfterFault: injected && calls > plan.times ? 1 : 0,
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
    // Load 1 opens the page, 2–4 calibrate and 5 checks the screen; then control,
    // fault, control, fault, cleanup.
    await withPage(
      (load) => (load === 7 ? 0 : 3),
      async (page) => {
        const result = report()
        await runDiscovery(setup(page, fakeSession()), timing, result)
        assert.equal(result.error, undefined, JSON.stringify(result.error))
        // A read after the check's faults succeeded, so the check can't tell.
        assert.equal(result.screenCheck.outcome, 'not-established')
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
  'a screen that stays healthy while every read fails stops the run before any experiment',
  { timeout: 30000 },
  async () => {
    await withPage(
      () => 3,
      async (page) => {
        const session = fakeSession({ calls: 3 })
        const result = report()
        await runDiscovery(setup(page, session), timing, result)
        assert.equal(result.error, 'FAULT_NOT_VISIBLE')
        assert.equal(result.page, page.url())
        assert.deepEqual(
          {
            injected: result.screenCheck.injected,
            outcome: result.screenCheck.outcome,
          },
          { injected: 3, outcome: 'unchanged' },
        )
        assert.deepEqual(
          session.plans.filter((plan) => plan.fault),
          [{ fault: 'rejection', times: 10 }],
        )
        assert.equal(result.results.length, 0)
        assert.equal(result.finalReset, 'healthy')
        assert.equal(result.ok, false)
      },
    )
  },
)

test(
  'a screen that changes while every read fails goes on to the experiments',
  { timeout: 30000 },
  async () => {
    // Load 5 is the screen check.
    await withPage(
      (load) => (load === 5 ? 0 : 3),
      async (page) => {
        const result = report()
        await runDiscovery(
          setup(page, fakeSession({ calls: 3 })),
          { ...timing, repeats: 1 },
          result,
        )
        assert.equal(result.error, undefined, JSON.stringify(result.error))
        assert.equal(result.screenCheck.outcome, 'changed')
        assert.deepEqual(
          result.findings.map((f) => f.classification),
          ['RECOVERED'],
        )
      },
    )
  },
)

test(
  'a screen check that leaves the page counts as a change and returns to it',
  { timeout: 30000 },
  async () => {
    await withPage(
      () => 3,
      async (page) => {
        const screen = page.url()
        const result = report()
        await runDiscovery(
          setup(page, fakeSession({ calls: 3 })),
          { ...timing, repeats: 1 },
          result,
        )
        assert.equal(result.error, undefined, JSON.stringify(result.error))
        assert.equal(result.screenCheck.outcome, 'changed')
        assert.equal(result.stoppedObservation, undefined)
        assert.equal(result.findings.length, 1)
        assert.equal(page.url(), screen)
        assert.equal(result.finalReset, 'healthy')
      },
      // Load 5 is the screen check.
      (load) => (load === 5 ? '<script>location.hash = "#/away"</script>' : ''),
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
