import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSelfCheck } from '../helpers/self-check-evaluation.mjs'

// Every case of test/fixtures/self-check-evaluation, scored against expected.json, which the
// self-check never sees. A case passes only when each of its checks does: the outcome, the
// problems and how they came about, the differences between runs, and cautious wording.
test(
  'the self-check evaluation: outcomes, findings and differences match what each case expects',
  { timeout: 900000 },
  async () => {
    const results = await evaluateSelfCheck()
    assert.equal(results.length, 8)
    for (const { id, actual, checks } of results) {
      const differences = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
      assert.deepEqual(differences, [], `${id}: ${JSON.stringify(actual)}`)
    }
    // The essential control: the corrected scenario still shows the defect it is for.
    const byId = Object.fromEntries(results.map((r) => [r.id, r.actual]))
    assert.equal(byId['defect-still-detected'].outcome, 'findings')
    assert.deepEqual(byId['defect-still-detected'].problems, [
      'EXPECTATION_NOT_MET',
    ])
    assert.ok(results.every((r) => r.checks.noFalseClean))
  },
)
