import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePlanner } from '../helpers/plan-evaluation.mjs'

// Every case of test/fixtures/plan-evaluation, scored against expected.json, which the planner
// never sees. A case passes only when each of its checks does: right selection, nothing
// irrelevant, the same gaps, the defect reproduced or not, and the expected verify verdict.
test(
  'the planner evaluation: selection, gaps, reproduction and verdicts match what each case expects',
  { timeout: 900000 },
  async () => {
    const results = await evaluatePlanner()
    assert.equal(results.length, 8)
    for (const { id, actual, checks } of results) {
      const differences = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
      assert.deepEqual(differences, [], `${id}: ${JSON.stringify(actual)}`)
    }
    // The negative controls: no assurance without a plan, and never a false VERIFIED.
    const byId = Object.fromEntries(results.map((r) => [r.id, r.actual]))
    assert.equal(byId['unrelated-change'].verdict, null)
    assert.equal(byId['unknown-requirement'].verdict, null)
    assert.equal(byId['regression-introduced'].verdict, 'NOT_VERIFIED')
    assert.ok(results.every((r) => r.checks.noFalseVerified))
  },
)
