import { test } from 'node:test'
import assert from 'node:assert/strict'
import { phaseVerdict } from '../../dist/workflows/check/ipc/verdict.mjs'
import { fake } from '../helpers/fake.mjs'

const channels = { channel: 'items', requiredChannels: ['user'] }
/** A channel's counters; the verdict reads only these. */
const row = (counts = {}) => ({
  calls: 1,
  successes: 1,
  errors: 0,
  pending: 0,
  ...counts,
})
/**
 * @param {{
 *   fault?: import('../../dist/transports/ipc/control.mjs').IpcFault,
 *   target?: object,
 *   user?: object,
 *   injected?: number,
 *   successfulAfterFault?: number,
 *   readyProblem?: string,
 *   expired?: boolean,
 * }} [state]
 */
const verdict = ({
  fault,
  target = {},
  user = {},
  injected = 0,
  successfulAfterFault = 0,
  readyProblem,
  expired = false,
} = {}) =>
  phaseVerdict(channels, {
    fault,
    snapshot: fake({
      injected,
      successfulAfterFault,
      channels: { items: row(target), user: row(user) },
    }),
    readyProblem,
    expired,
  })
const recovered = { injected: 1, successfulAfterFault: 1 }

test('a phase passes once its read, dependencies and screen are ready', () => {
  assert.deepEqual(verdict(), { outcome: 'pass', code: 'BASELINE_READY' })
  assert.deepEqual(
    verdict({ fault: 'rejection', target: { calls: 2 }, ...recovered }),
    { outcome: 'pass', code: 'RECOVERED' },
  )
  assert.equal(
    verdict({ readyProblem: 'the ready element is hidden' }),
    undefined,
  )
  assert.equal(verdict({ target: { pending: 1 } }), undefined)
  assert.equal(verdict({ user: { pending: 1 } }), undefined)
})

test('extra traffic or a failed dependency makes the phase inconclusive', () => {
  assert.equal(verdict({ target: { calls: 2 } }).code, 'BASELINE_AMBIGUOUS')
  assert.equal(
    verdict({ fault: 'rejection', target: { calls: 3 } }).code,
    'TRAFFIC_AMBIGUOUS',
  )
  assert.deepEqual(verdict({ user: { errors: 1 }, target: { calls: 5 } }), {
    outcome: 'inconclusive',
    code: 'DEPENDENCY_FAILED',
  })
})

test('an expired phase says what was missing', () => {
  const expired = (state) =>
    verdict({ expired: true, readyProblem: 'hidden', ...state })
  assert.equal(expired().code, 'BASELINE_FAILED')
  assert.equal(expired({ fault: 'null-result' }).code, 'FAULT_NOT_TRIGGERED')
  assert.equal(
    expired({ fault: 'rejection', injected: 1, user: { successes: 0 } }).code,
    'DEPENDENCY_NOT_READY',
  )
  assert.deepEqual(expired({ fault: 'rejection', ...recovered }), {
    outcome: 'fail',
    code: 'RECOVERY_NOT_OBSERVED',
  })
})

test('a failed baseline says the first thing that was missing', () => {
  const reason = (state) => verdict({ expired: true, ...state }).reason
  assert.equal(
    reason({ target: { calls: 0, successes: 0 } }),
    'the app made no items call',
  )
  assert.equal(
    reason({ target: { pending: 1, successes: 0 } }),
    "the items call didn't finish",
  )
  assert.equal(
    reason({ target: { successes: 0 } }),
    "the items call didn't succeed",
  )
  assert.equal(
    reason({ user: { successes: 0 }, readyProblem: 'hidden' }),
    "the required user call didn't succeed",
  )
  assert.equal(
    reason({ readyProblem: 'the ready selector matched 2 elements' }),
    'the ready selector matched 2 elements',
  )
})
