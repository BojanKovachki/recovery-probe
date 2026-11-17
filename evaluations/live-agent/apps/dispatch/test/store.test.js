import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../public/src/store.js'
import { money, statusLabel } from '../public/src/format.js'

const ORDERS = [
  { id: 'ORD-1', customer: 'A', status: 'new', total: 10, updatedAt: '' },
  { id: 'ORD-2', customer: 'B', status: 'packed', total: 20, updatedAt: '' },
]

test('loading asks for the selected filter and shows its orders', async () => {
  const asked = []
  const store = createStore({
    listOrders: async (status) => {
      asked.push(status)
      return ORDERS.filter((order) => !status || order.status === status)
    },
  })
  await store.load('packed')
  assert.deepEqual(asked, ['packed'])
  assert.equal(store.state.filter, 'packed')
  assert.deepEqual(
    store.state.orders.map((order) => order.id),
    ['ORD-2'],
  )
  assert.equal(store.state.loading, false)
})

test('a failed first load says the orders could not be loaded', async () => {
  const store = createStore({
    listOrders: async () => {
      throw new Error('HTTP 503')
    },
  })
  await store.load('')
  assert.equal(store.state.error, 'Could not load orders.')
  assert.equal(store.state.loading, false)
})

test('subscribers hear about each change', async () => {
  const store = createStore({ listOrders: async () => ORDERS })
  const seen = []
  store.subscribe((state) => seen.push(state.loading))
  await store.load('')
  assert.deepEqual(seen, [false])
})

test('statuses and totals are shown the way the team reads them', () => {
  assert.equal(statusLabel('packed'), 'Packed')
  assert.equal(money(89.5), '€89.50')
})
