import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry } from '../public/src/retry.js'
import { newestFirst, stateLabel } from '../public/src/format.js'

const noWait = async () => {}

test('a read that fails once is retried and its answer returned', async () => {
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls === 1) throw new Error('network down')
      return 'services'
    },
    [1000, 2000, 4000],
    noWait,
  )
  assert.equal(result, 'services')
  assert.equal(calls, 2)
})

test('the retries wait the delays they are given', async () => {
  const waited = []
  await assert.rejects(
    withRetry(
      async () => {
        throw new Error('network down')
      },
      [1000, 2000, 4000],
      async (ms) => waited.push(ms),
    ),
    /network down/,
  )
  assert.deepEqual(waited, [1000, 2000, 4000])
})

test('states read the way the team names them', () => {
  assert.equal(stateLabel('degraded'), 'Degraded')
})

test('notifications are listed newest first', () => {
  const sorted = newestFirst([
    { id: 'old', createdAt: '2026-11-01T08:00:00.000Z' },
    { id: 'new', createdAt: '2026-11-02T08:00:00.000Z' },
  ])
  assert.deepEqual(
    sorted.map((n) => n.id),
    ['new', 'old'],
  )
})
