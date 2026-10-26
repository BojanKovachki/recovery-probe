import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reportPaths } from '../helpers/report-shape.mjs'

test('report paths keep the fields every array element has, and skip per-run data', () => {
  assert.deepEqual(
    reportPaths({
      status: 'complete',
      findings: [
        { code: 'A', interval: 1, afterAction: { name: 'start' } },
        { code: 'B', interval: 2 },
      ],
      snapshot: { channels: { 'http://127.0.0.1:5173/api': { calls: 1 } } },
      timeline: [{ ui: { presence: 'present' } }],
      empty: [],
    }),
    [
      '$',
      '$.empty',
      '$.findings',
      '$.findings[]',
      '$.findings[].code',
      '$.findings[].interval',
      '$.snapshot',
      '$.snapshot.channels',
      '$.snapshot.channels.<url>',
      '$.snapshot.channels.<url>.calls',
      '$.status',
      '$.timeline',
    ],
  )
})
