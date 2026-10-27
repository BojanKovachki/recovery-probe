import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observationConfig } from '../../dist/workflows/observe/config.mjs'
import { SlowReadTracker } from '../../dist/workflows/observe/slow-reads/evidence.mjs'
import { duration } from '../../dist/workflows/observe/slow-reads/summary.mjs'
import { ObservationRecorder } from '../../dist/workflows/observe/recorder.mjs'

/** @typedef {import('../../dist/workflows/observe/slow-reads/evidence.mjs').LoadPoint} LoadPoint */
/** @typedef {import('../../dist/transports/http/read-log.mjs').ReadRecord} ReadRecord */
/** @typedef {import('../../dist/workflows/observe/slow-reads/bridge.mjs').BridgeCounts} BridgeCounts */

const http = (extra = {}) => ({
  transport: 'http',
  endpoint: 'http://127.0.0.1:1/api/contacts',
  regionSelector: '#region',
  contentSelector: 'li',
  ...extra,
})

test('slowReads config: defaults, bridge id key and limits', () => {
  assert.deepEqual(observationConfig(http({ slowReads: {} })).slowReads, {
    thresholdMs: 3000,
  })
  assert.deepEqual(
    observationConfig(http({ slowReads: { bridge: { global: 'sdkBridge' } } }))
      .slowReads,
    { thresholdMs: 3000, bridge: { global: 'sdkBridge', idKey: 'id' } },
  )
  assert.equal(
    observationConfig(http({ slowReads: {}, observationMs: 600000 }))
      .observationMs,
    600000,
  )
  for (const [input, message] of [
    [{ slowReads: { other: 1 } }, /slowReads must be/],
    [{ slowReads: { thresholdMs: 100 } }, /thresholdMs must be an integer/],
    [{ slowReads: { bridge: { global: 'a.b' } } }, /slowReads.bridge must be/],
    [{ slowReads: { bridge: { global: 'b', idKey: '' } } }, /slowReads.bridge/],
    [{ observationMs: 600001 }, /observationMs/],
  ])
    assert.throws(() => observationConfig(http(input)), message)
})

test('slowReads config: HTTP only, and IPC keeps the hook’s 120 s limit', () => {
  const ipc = {
    transport: 'ipc',
    channel: 'app:read',
    regionSelector: '#r',
    contentSelector: 'li',
  }
  assert.throws(
    () => observationConfig({ ...ipc, slowReads: {} }),
    /slowReads is only supported with HTTP/,
  )
  assert.throws(
    () => observationConfig({ ...ipc, observationMs: 120001 }),
    /at most 120000 with IPC/,
  )
  assert.equal(
    observationConfig({ ...ipc, observationMs: 120000 }).observationMs,
    120000,
  )
})

test('duration: seconds below a minute, minutes and seconds above', () => {
  assert.equal(duration(850), '0.9 s')
  assert.equal(duration(59949), '59.9 s')
  assert.equal(duration(59950), '1 min 0 s')
  assert.equal(duration(242000), '4 min 2 s')
})

const EPOCH = 1_000_000

/**
 * Samples every 100 ms from 0 to `endMs`. Content shows from `contentAt`; the renderer
 * runs `busyPerSample` ms of tasks per sample from `busyFrom`.
 * @param {{ endMs?: number, contentAt?: number, busyFrom?: number, busyPerSample?: number, bridge?: (ms: number) => BridgeCounts }} [options]
 * @returns {LoadPoint[]}
 */
function samples({
  endMs = 6000,
  contentAt = Infinity,
  busyFrom = 0,
  busyPerSample = 5,
  bridge,
} = {}) {
  const points = []
  let taskMs = 0
  for (let fromMs = 0; fromMs < endMs; fromMs += 100) {
    taskMs += fromMs >= busyFrom ? busyPerSample : 5
    points.push({
      interval: 1,
      fromMs,
      toMs: fromMs + 50,
      content: fromMs >= contentAt,
      screenReadMs: 50,
      load: {
        renderer: { taskMs, scriptMs: taskMs / 2 },
        bridge: bridge ? bridge(fromMs) : null,
      },
    })
  }
  return points
}

/**
 * @param {{ start: number, end?: number | null, status?: number | null, outcome?: ReadRecord['outcome'], networkMs?: number | null }} r
 * @returns {ReadRecord}
 */
const read = ({
  start,
  end = null,
  status = 200,
  outcome = 'success',
  networkMs = null,
}) => ({
  startedAt: EPOCH + start,
  completedAt: end === null ? null : EPOCH + end,
  status: end === null ? null : status,
  outcome: end === null ? 'pending' : outcome,
  networkMs: end === null ? null : (networkMs ?? end - start),
})

function conclude(
  points,
  reads,
  { thresholdMs = 3000, endMs = 6000, bridge = null } = {},
) {
  const tracker = new SlowReadTracker({ thresholdMs })
  for (const point of points) tracker.add(point)
  return tracker.conclude({
    readLog: { reads, truncated: false },
    intervals: [{ index: 1, startMs: 0 }],
    startedEpoch: EPOCH,
    endMs,
    probe: { renderer: { measured: true }, bridge },
  })
}

test('slow reads: a busy renderer after a fast response', () => {
  const { section, findings } = conclude(
    samples({ contentAt: 4500, busyFrom: 600, busyPerSample: 95 }),
    [read({ start: 500, end: 600 })],
  )
  const [r] = section.reads
  assert.deepEqual(r.contentShownMs, [4500, 4550])
  assert.equal(r.slow, true)
  assert.ok(r.rendererBusyPercent >= 85, `busy ${r.rendererBusyPercent}%`)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].basis, 'RENDERER_BUSY')
  assert.equal(
    findings[0].summary,
    `The response took 0.1 s (HTTP 200), but content appeared 4.0–4.1 s after the read started: the renderer’s main thread was busy ${r.rendererBusyPercent}% of that time.`,
  )
})

test('slow reads: a slow response', () => {
  const { findings } = conclude(samples({ contentAt: 4100 }), [
    read({ start: 500, end: 4000 }),
  ])
  assert.equal(findings[0].basis, 'NETWORK')
  assert.match(
    findings[0].summary,
    /^The response took 3\.5 s \(HTTP 200\); content appeared/,
  )
})

test('slow reads: content late after a fast response while the renderer idles', () => {
  const { findings } = conclude(samples({ contentAt: 4500 }), [
    read({ start: 500, end: 600 }),
  ])
  assert.equal(findings[0].basis, 'AFTER_RESPONSE')
  assert.match(
    findings[0].summary,
    /busy 5% of that time\. The screen waited on something other than this read/,
  )
})

test('slow reads: content that never appears, and a read that never finishes', () => {
  const { section, findings } = conclude(samples(), [
    read({ start: 500, end: 600 }),
    read({ start: 1000 }),
  ])
  assert.deepEqual(
    findings.map((f) => [f.basis, f.read]),
    [
      ['NO_CONTENT', 0],
      ['STILL_PENDING', 1],
    ],
  )
  assert.equal(section.reads[1].outcome, 'pending')
  assert.equal(
    findings[1].summary,
    'It started 1.0 s into the interval. The read started 5.0 s before the capture ended and had not finished; the renderer’s main thread was busy 5% of that time.',
  )
})

test('slow reads: a fast read is listed but not reported', () => {
  const { section, findings } = conclude(samples({ contentAt: 900 }), [
    read({ start: 500, end: 600 }),
  ])
  assert.equal(section.reads[0].slow, false)
  assert.deepEqual(section.reads[0].contentShownMs, [900, 950])
  assert.deepEqual(findings, [])
})

test('slow reads: content already showing says nothing about a refresh', () => {
  const { section, findings } = conclude(samples({ contentAt: 0 }), [
    read({ start: 2000, end: 2100 }),
  ])
  assert.equal(section.reads[0].contentAlreadyShown, true)
  assert.equal(section.reads[0].contentShownMs, null)
  assert.deepEqual(findings, [])
})

test('slow reads: earlier failures and waiting bridge requests are named', () => {
  const { section, findings } = conclude(
    samples({
      contentAt: 5000,
      busyFrom: 2000,
      busyPerSample: 95,
      bridge: (ms) => ({
        sent: 40,
        answered: 10,
        pending: 30,
        maxPending: ms >= 2000 ? 30 : 0,
      }),
    }),
    [
      read({ start: 200, end: 300, status: 500, outcome: 'error' }),
      read({ start: 600, end: 700, outcome: 'failed', status: null }),
      read({ start: 2000, end: 2100 }),
    ],
    { bridge: { global: 'sdkBridge', installed: true } },
  )
  assert.deepEqual(section.bridge, {
    global: 'sdkBridge',
    installed: true,
    sent: 40,
    answered: 10,
    pendingAtEnd: 30,
  })
  assert.deepEqual(
    section.reads.map((r) => r.outcome),
    ['error', 'failed', 'success'],
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].read, 2)
  assert.equal(
    findings[0].summary,
    '2 earlier reads in this interval failed. It started 2.0 s into the interval. The response took 0.1 s (HTTP 200), but content appeared 3.0–3.1 s after the read started: the renderer’s main thread was busy 95% of that time; up to 30 bridge requests were waiting.',
  )
})

test('slow reads: a capture that failed before its first interval still concludes', () => {
  const recorder = new ObservationRecorder(
    observationConfig(http({ slowReads: {} })),
  )
  recorder.conclude({
    readLog: { reads: [read({ start: 100, end: 200 })], truncated: false },
    probe: { renderer: { measured: true }, bridge: null },
    startedEpoch: EPOCH,
  })
  assert.equal(recorder.report.slowReads, undefined)
})
