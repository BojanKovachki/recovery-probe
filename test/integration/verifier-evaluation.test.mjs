import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateVerifier } from '../helpers/verifier-evaluation.mjs'

// Every case of test/fixtures/verifier-evaluation, scored against expected.json, which the
// verifier never sees. Each case launches the synthetic app from the base and candidate
// checkouts, and passes only with the expected verdict, claim, exit code and base comparison.
test(
  'the verifier evaluation: a fix, a regression, an untriggered fault, a missing and a changed expectation and a budget stop',
  { timeout: 900000 },
  async () => {
    const results = await evaluateVerifier()
    assert.equal(results.length, 6)
    for (const { id, actual, checks } of results) {
      const differences = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
      assert.deepEqual(differences, [], `${id}: ${JSON.stringify(actual)}`)
    }
    // Only the fix verifies, and only the regression exits 1.
    assert.deepEqual(
      results.map(({ id, actual }) => [id, actual.verdict, actual.exitCode]),
      [
        ['fix', 'VERIFIED', 0],
        ['regression', 'NOT_VERIFIED', 1],
        ['untriggered-fault', 'NOT_VERIFIED', 2],
        ['missing-expectation', 'NOT_VERIFIED', 2],
        ['changed-expectation', 'NOT_VERIFIED', 2],
        ['budget-stop', 'NOT_VERIFIED', 2],
      ],
    )
  },
)
