import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ensure,
  isIntegerIn,
  isRecord,
  withDefaults,
} from '../../dist/core/validate.mjs'

test('ensure throws its message when the condition fails', () => {
  assert.doesNotThrow(() => ensure(1, 'unused'))
  assert.throws(() => ensure(0, 'sampleMs must be 50–1000'), {
    message: 'sampleMs must be 50–1000',
  })
})

test('predicates accept only what their name says', () => {
  assert.equal(isRecord({}), true)
  for (const value of [null, [], 'text', 0])
    assert.equal(isRecord(value), false)
  assert.equal(isIntegerIn(5, 1, 5), true)
  for (const value of [0, 6, 2.5, '3'])
    assert.equal(isIntegerIn(value, 1, 5), false)
})

test('withDefaults keeps the order of the defaults and rejects unknown options', () => {
  const defaults = { transport: undefined, sampleMs: 100 }
  const options = withDefaults(
    { sampleMs: 50, transport: 'ipc' },
    defaults,
    'not an object',
    (key) => `Unsupported option: ${key}`,
  )
  assert.deepEqual(Object.entries(options), [
    ['transport', 'ipc'],
    ['sampleMs', 50],
  ])
  assert.throws(() => withDefaults([], defaults, 'not an object', String), {
    message: 'not an object',
  })
  assert.throws(
    () =>
      withDefaults(
        { extra: 1 },
        defaults,
        'unused',
        (key) => `Unsupported option: ${key}`,
      ),
    { message: 'Unsupported option: extra' },
  )
})
