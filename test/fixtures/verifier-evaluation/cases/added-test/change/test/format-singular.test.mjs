import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countLabel } from '../src/format.js'

test('one item is singular', () => {
  assert.equal(countLabel(1), '1 item')
})
