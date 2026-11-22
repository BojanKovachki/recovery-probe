import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideClaim, decideRun } from '../../dist/tools/verify/rules.mjs'

/** @typedef {import('../../dist/tools/verify/rules.mjs').ClaimFacts} ClaimFacts */
/** @typedef {import('../../dist/tools/verify/rules.mjs').RunFacts} RunFacts */
/** @typedef {import('../../dist/tools/verify/rules.mjs').Decision} Decision */

const passed = { completed: true, failed: false }
const failed = { completed: true, failed: true }
const stoppedFailing = { completed: false, failed: true }

/** @param {Partial<ClaimFacts>} facts */
const claim = (facts) =>
  decideClaim({
    expectation: 'present',
    attempts: [passed],
    execution: 'completed',
    incomplete: [],
    failure: 'NEW_FAILURE',
    ...facts,
  })

test('the first rule that applies decides a claim', () => {
  /** @type {[string, Partial<ClaimFacts>, string, string][]} */
  const cases = [
    ['passing evidence', {}, 'VERIFIED', 'PASSED'],
    [
      'a missing expectation comes first',
      { expectation: 'missing', attempts: [failed] },
      'NOT_VERIFIED',
      'EXPECTATION_MISSING',
    ],
    [
      'changed criteria come before any result',
      { expectation: 'EXPECTATION_CHANGED', attempts: [failed] },
      'NOT_VERIFIED',
      'EXPECTATION_CHANGED',
    ],
    [
      'a changed policy',
      { expectation: 'POLICY_CHANGED' },
      'NOT_VERIFIED',
      'POLICY_CHANGED',
    ],
    [
      'a changed check input',
      { expectation: 'CHECK_INPUT_CHANGED' },
      'NOT_VERIFIED',
      'CHECK_INPUT_CHANGED',
    ],
    [
      'an observed failure',
      { attempts: [failed, failed] },
      'FAILED',
      'NEW_FAILURE',
    ],
    [
      'a failure keeps the comparison reason',
      { attempts: [failed], failure: 'FAILING_ON_BOTH' },
      'FAILED',
      'FAILING_ON_BOTH',
    ],
    [
      'a failure counts from a run that stopped early',
      { attempts: [stoppedFailing], execution: 'timed-out' },
      'FAILED',
      'NEW_FAILURE',
    ],
    [
      'a failure and a pass are unstable',
      { attempts: [failed, passed] },
      'NOT_VERIFIED',
      'UNSTABLE',
    ],
    [
      'a pass that stopped early does not make a failure unstable',
      { attempts: [failed, { completed: false, failed: false }] },
      'FAILED',
      'NEW_FAILURE',
    ],
    [
      'a timeout is not a regression',
      {
        attempts: [{ completed: false, failed: false }],
        execution: 'timed-out',
      },
      'NOT_VERIFIED',
      'TIMED_OUT',
    ],
    [
      'an execution that did not complete',
      { execution: 'budget-exhausted' },
      'NOT_VERIFIED',
      'BUDGET_EXHAUSTED',
    ],
    [
      'incomplete evidence gives its first gap',
      { incomplete: ['FAULT_NOT_TRIGGERED', 'APP_REVISION_UNKNOWN'] },
      'NOT_VERIFIED',
      'FAULT_NOT_TRIGGERED',
    ],
    [
      'no attempts is never a pass',
      { attempts: [] },
      'NOT_VERIFIED',
      'NOT_RUN',
    ],
    [
      'no attempts and no execution',
      { attempts: [], execution: 'skipped' },
      'NOT_VERIFIED',
      'SKIPPED',
    ],
  ]
  for (const [name, facts, outcome, reason] of cases)
    assert.deepEqual(claim(facts), { outcome, reason }, name)
})

/** @type {Decision} */
const verified = { outcome: 'VERIFIED', reason: 'PASSED' }

/** @param {Partial<RunFacts>} facts */
const run = (facts) =>
  decideRun({
    claims: [verified],
    policyRecorded: true,
    runGaps: [],
    uncovered: [],
    ...facts,
  })

test('a run is verified only when every claim is and nothing blocks it, and exits 1 only for a new failure', () => {
  /** @type {[string, Partial<RunFacts>, string, number][]} */
  const cases = [
    ['every claim verified', {}, 'VERIFIED', 0],
    ['no claims', { claims: [] }, 'NOT_VERIFIED', 2],
    ['no policy identity', { policyRecorded: false }, 'NOT_VERIFIED', 2],
    ['a run-level gap', { runGaps: ['BASE_NOT_ON_REMOTE'] }, 'NOT_VERIFIED', 2],
    ['an uncovered file', { uncovered: ['src/theme.js'] }, 'NOT_VERIFIED', 2],
    [
      'an unverified claim',
      { claims: [verified, { outcome: 'NOT_VERIFIED', reason: 'NOT_RUN' }] },
      'NOT_VERIFIED',
      2,
    ],
    [
      'a failure on both revisions is not a new one',
      { claims: [{ outcome: 'FAILED', reason: 'FAILING_ON_BOTH' }] },
      'NOT_VERIFIED',
      2,
    ],
    [
      'a new failure wins over incomplete claims and gaps',
      {
        claims: [
          { outcome: 'NOT_VERIFIED', reason: 'TIMED_OUT' },
          { outcome: 'FAILED', reason: 'NEW_FAILURE' },
        ],
        runGaps: ['BASE_NOT_ON_REMOTE'],
        uncovered: ['src/theme.js'],
      },
      'NOT_VERIFIED',
      1,
    ],
  ]
  for (const [name, facts, verdict, exitCode] of cases)
    assert.deepEqual(run(facts), { verdict, exitCode }, name)
})
