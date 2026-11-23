import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countLabel } from '../src/format.js'

test('several items are plural', () => {
  assert.equal(countLabel(3), '3 items')
})
