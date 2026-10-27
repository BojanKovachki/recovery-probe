import { test } from 'node:test'
import assert from 'node:assert/strict'
import { screenQuote } from '../../dist/workflows/check/screen.mjs'

const healthy = ['Orders', 'Order 1001', 'Order 1002']

test('quotes the lines the healthy screen did not show', () => {
  assert.equal(
    screenQuote(['Orders', 'You have no orders yet'], healthy),
    'You have no orders yet',
  )
  assert.equal(
    screenQuote(['Orders', 'Error', 'Retry', 'Error'], healthy),
    'Error\nRetry',
  )
  assert.equal(screenQuote(['Orders'], healthy), undefined)
})

test('keeps the quote short', () => {
  const quote = screenQuote(['x'.repeat(500)], healthy)
  assert.equal(quote.length, 200)
  assert.ok(quote.endsWith('…'))
})
