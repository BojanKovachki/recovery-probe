import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countLabel } from '../src/format.js'

test('one entry is singular', () => {
  assert.equal(countLabel(1), '1 entry')
})

test('several entries are plural', () => {
  assert.equal(countLabel(3), '3 entries')
})
