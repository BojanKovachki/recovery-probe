import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  calibrationWorstCaseMs,
  cleanupReserveMs,
  estimateDiscovery,
  experimentWorstCaseMs,
  loadWorstCaseMs,
  mostExperiments,
  RunBudget,
} from '../../dist/workflows/discover/budget.mjs'
import { httpDiscoveryConfig } from '../../dist/workflows/discover/http.mjs'
import { discoveryConfig } from '../../dist/workflows/discover/ipc.mjs'
import { load } from '../../dist/workflows/discover/load.mjs'
import {
  writeDiscoveryProgress,
  writeDiscoveryReport,
} from '../../dist/reports/discovery.mjs'
import { fake } from '../helpers/fake.mjs'

const defaults = { baselineTimeoutMs: 15000, observationMs: 8000, repeats: 3 }

test('the estimate counts every reload of a run and its longest duration', () => {
  // A healthy load is watched for the baseline window, a faulted one for the observation window more.
  assert.equal(loadWorstCaseMs(defaults, false), 17000)
  assert.equal(loadWorstCaseMs(defaults, true), 25000)
  assert.equal(experimentWorstCaseMs(defaults), 3 * (17000 + 25000))
  assert.equal(calibrationWorstCaseMs(defaults), 3 * 17000 + 25000)
  assert.equal(cleanupReserveMs(defaults), 17000 + 5000)
  // Three faults and every read failing, as discovery runs by default: the documented 29 reloads.
  const exact = estimateDiscovery(defaults, 4, true)
  assert.equal(exact.plannedLoads, 29)
  assert.equal(exact.worstCaseMs, 76000 + 4 * 126000 + 22000)
  // Before calibration counts the reads of a load, up to three later calls may be failed one by one.
  assert.equal(mostExperiments(3, true), 7)
  assert.equal(mostExperiments(3, false), 4)
  const before = estimateDiscovery(defaults, mostExperiments(3, true), false)
  assert.equal(before.plannedLoads, 3 + 1 + 7 * 6 + 1)
  assert.ok(before.worstCaseMs > exact.worstCaseMs)
})

test('a budget keeps its cleanup reserve and says whether a step still fits', () => {
  let now = 1000
  const budget = new RunBudget(60000, 20000, undefined, () => now)
  assert.equal(budget.workLeftMs(), 40000)
  assert.equal(budget.totalLeftMs(), 60000)
  now += 30000
  assert.equal(budget.elapsedMs(), 30000)
  assert.equal(budget.workLeftMs(), 10000)
  assert.equal(budget.totalLeftMs(), 30000)
  assert.equal(budget.fits(10000), true)
  assert.equal(budget.fits(10001), false)
  now += 15000
  assert.ok(budget.workLeftMs() < 0)
  assert.equal(budget.totalLeftMs(), 15000)
})

test('maxDurationMs is optional, and 10 seconds to 24 hours when given', () => {
  const endpoint = 'http://127.0.0.1:3000/api/items'
  assert.equal(httpDiscoveryConfig({ endpoint }).maxDurationMs, undefined)
  assert.equal(
    httpDiscoveryConfig({ endpoint, maxDurationMs: 10000 }).maxDurationMs,
    10000,
  )
  assert.equal(
    discoveryConfig({ channel: 'files:read', maxDurationMs: 86400000 })
      .maxDurationMs,
    86400000,
  )
  for (const maxDurationMs of [9999, 86400001, 15000.5, '60000'])
    for (const read of [
      () => httpDiscoveryConfig({ endpoint, maxDurationMs }),
      // A configuration file can hold anything, so the wrong types are tested too.
      () =>
        discoveryConfig(
          /** @type {any} */ ({ channel: 'files:read', maxDurationMs }),
        ),
    ])
      assert.throws(read, /maxDurationMs must be 10000–86400000/)
})

/**
 * A load's context over a fake page and session; after `stopAfter` checks, the run must stop.
 * @param {{ stopAfter?: number, timeLeftMs?: number, reload?: () => Promise<void> }} [options]
 */
function loadContext({ stopAfter = Infinity, timeLeftMs, reload } = {}) {
  const calls = { reloadTimeouts: [], stops: 0, checks: 0 }
  const snapshot = {
    injected: 0,
    injectedAt: null,
    successfulAfterFault: 0,
    channels: { read: { realCalls: 1, successes: 1, errors: 0, pending: 0 } },
  }
  const context = {
    setup: {
      page: {
        reload: async ({ timeout }) => {
          calls.reloadTimeouts.push(timeout)
          await reload?.()
        },
      },
      session: {
        begin: async () => {},
        snapshot: () => snapshot,
        stop: async () => {
          calls.stops++
        },
      },
      read: 'read',
      dependencies: [],
      readKind: 'endpoint',
      readFailed: 'REAL_REQUEST_FAILED',
      experiments: [],
      verification: '',
    },
    timing: {
      baselineTimeoutMs: 5000,
      observationMs: 1000,
      settleMs: 200,
      repeats: 1,
      restoreWindow: false,
    },
    report: {
      baselines: [],
      results: [],
      findings: [],
      finalReset: 'not-verified',
      ok: false,
      readiness: { calibrationComplete: false },
    },
    screen: async () => ({
      fingerprint: 'same',
      loading: false,
      visible: true,
      online: true,
    }),
    errors: () => 0,
    trustedFingerprint: () => undefined,
    stopReason: () =>
      ++calls.checks > stopAfter ? 'BUDGET_EXHAUSTED' : undefined,
    timeLeftMs: () => timeLeftMs,
  }
  return { context: fake(context), calls, report: context.report }
}

test('a load that reaches the deadline stops, clears its faults and records where it was', async () => {
  // A calibration load would watch the whole baseline window; the deadline cuts it short.
  const { context, calls, report } = loadContext({
    stopAfter: 2,
    timeLeftMs: 1234.7,
  })
  await assert.rejects(load(context, { calibrate: true }), /BUDGET_EXHAUSTED/)
  assert.deepEqual(calls.reloadTimeouts, [1234])
  assert.equal(calls.stops, 1)
  assert.equal(report.stoppedObservation.reason, 'BUDGET_EXHAUSTED')
})

test('without a time limit a reload keeps its own timeout', async () => {
  const { context, calls } = loadContext({ timeLeftMs: undefined })
  const phase = await load(context)
  assert.equal(phase.ready, true)
  assert.deepEqual(calls.reloadTimeouts, [5000])
})

test('a reload cut short by the deadline stops for the deadline, not as a timeout', async () => {
  const { context } = loadContext({
    stopAfter: 1,
    timeLeftMs: 50,
    reload: async () => {
      throw new Error('page.reload: Timeout 50ms exceeded.')
    },
  })
  await assert.rejects(load(context), /^Error: BUDGET_EXHAUSTED$/)
})

test('progress and the partial report are saved whole, and the final report replaces the partial one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rp-discovery-progress-'))
  try {
    const report = {
      mode: 'HTTP discovery',
      findings: [
        {
          id: 'http-error-2',
          classification: 'RECOVERED',
          kind: 'observation',
          confirmations: 1,
          repeatConfirmed: false,
          advice: '',
          fault: 'http-error',
          times: 2,
        },
      ],
      limitation: '',
      baselines: [],
      results: [],
    }
    /** @type {import('../../dist/workflows/discover/types.mjs').DiscoveryProgress} */
    const progress = {
      phase: 'experimenting',
      completedLoads: 7,
      plannedLoads: 13,
      elapsedMs: 4200,
      worstCaseRemainingMs: 30000,
      experiments: {
        planned: ['http-error-2', 'http-error-every-read'],
        done: ['http-error-2'],
      },
      budget: { maxDurationMs: 60000, remainingMs: 55800 },
    }
    await writeDiscoveryProgress(directory, progress, report)
    const saved = JSON.parse(
      await readFile(join(directory, 'progress.json'), 'utf8'),
    )
    assert.deepEqual(
      { ...saved, updatedAt: undefined },
      {
        ...progress,
        updatedAt: undefined,
      },
    )
    assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)))
    const partial = JSON.parse(
      await readFile(join(directory, 'report.partial.json'), 'utf8'),
    )
    // Partial evidence never counts as complete, whatever the run found so far.
    assert.equal(partial.evidence.complete, false)
    assert.ok(partial.evidence.gaps.includes('RUN_IN_PROGRESS'))
    assert.deepEqual(partial.evidence.checked, [])
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
      [],
    )
    await writeDiscoveryReport(directory, report, {})
    const files = await readdir(directory)
    assert.ok(files.includes('report.json'))
    assert.ok(!files.includes('report.partial.json'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
