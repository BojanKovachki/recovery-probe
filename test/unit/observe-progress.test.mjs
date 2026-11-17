import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observationConfig } from '../../dist/workflows/observe/config.mjs'
import { progressPercent } from '../../dist/workflows/observe/progress.mjs'
import { ObservationRecorder } from '../../dist/workflows/observe/recorder.mjs'
import {
  summarizeRows,
  RowTracker,
} from '../../dist/workflows/observe/rows.mjs'
import { fake } from '../helpers/fake.mjs'

/** @typedef {import('../../dist/workflows/observe/progress.mjs').ProgressWentBackFinding} ProgressWentBackFinding */
/** @typedef {Parameters<RowTracker['add']>[0]} RowSample */

test('progress is read from percentages and from done / total amounts', () => {
  /** @type {[string, number | null][]} */
  const cases = [
    ['45%', 45],
    ['45,5 %', 45.5],
    ['0.3 / 1.2 GB', 25],
    ['0,3 / 1,2 GB', 25],
    ['0.0 GB / 1.2 GB', 0],
    ['300 MB of 1.2 GB', 24.41],
    ['512 KiB / 1 MiB', 50],
    ['1,024 MB / 2,048 MB', 50],
    ['1.234,5 / 2.469 MB', 50],
    ['0.375 / 1.5 GB', 25],
    ['3 of 12', 25],
    ['1 / 3', 33.33],
    // A percentage wins over amounts in the same text.
    ['Downloading 30% (0.3 / 1.2 GB)', 30],
    ['0.3 GB · 3.2 MB/s', null],
    ['1 / 0', null],
    ['NaN / 100', null],
    ['Paused', null],
    ['', null],
  ]
  for (const [text, percent] of cases)
    assert.equal(progressPercent(text), percent, text)
})

test('a download that only grows never reads as going back when its text changes format', () => {
  for (const texts of [
    ['999 MB / 2,048 MB', '1,000 MB / 2,048 MB'],
    ['999 MB / 2.048 MB', '1.000 MB / 2.048 MB'],
    // Apps that move from MB to GB at 1024 and at 1000.
    ['1023 MB / 1.2 GB', '1.0 GB / 1.2 GB'],
    ['999 MB / 1.2 GB', '1.0 GB / 1.2 GB'],
  ]) {
    const [before, after] = texts.map(progressPercent)
    assert.ok(after >= before, `${texts.join(' → ')}: ${before} → ${after}`)
  }
})

test('row summaries keep the progress number, never its text', () => {
  const rows = summarizeRows(
    {
      truncated: false,
      items: [
        { key: 'a', state: null, progress: 'synthetic-private 0.3 / 1.2 GB' },
        { key: 'b', state: null, progress: 'Paused' },
        { key: 'c', state: null, progress: null },
        { key: 'd', state: null },
      ],
    },
    { states: [], aliases: {} },
  )
  assert.deepEqual(
    rows.items.map((item) => item.progress),
    [25, undefined, undefined, undefined],
  )
  assert.ok(!('progress' in rows.items[1]))
  assert.ok(!JSON.stringify(rows).includes('synthetic-private'))
})

test('rows.progress is a selector, and enough for rows on its own', () => {
  const base = {
    transport: 'http',
    endpoint: 'http://localhost/api',
    regionSelector: '#r',
    contentSelector: 'li',
  }
  const config = observationConfig({
    ...base,
    rows: { selector: 'li', progress: { role: 'progressbar' } },
  })
  assert.deepEqual(config.rows.progress, { role: 'progressbar' })
  assert.deepEqual(observationConfig(config).rows, config.rows)
  for (const progress of ['', { name: 'x' }])
    assert.throws(
      () => observationConfig({ ...base, rows: { selector: 'li', progress } }),
      /rows\.progress/,
    )
})

/** @returns {RowSample} */
const sample = (index, progress) =>
  fake({
    index,
    interval: 1,
    fromMs: index * 100,
    toMs: index * 100 + 50,
    rows: {
      items:
        progress === null
          ? []
          : [
              {
                row: 'second',
                state: 'none',
                ...(progress === undefined ? {} : { progress }),
              },
            ],
    },
    completed: 0,
    data: null,
  })

const tracker = () =>
  new RowTracker(
    fake({
      rows: { states: [], progress: '.progress' },
      lagThresholdMs: 1000,
      minUnchangedReads: 2,
    }),
  )

const track = (values, actions = []) => {
  const t = tracker()
  t.addActions(actions)
  values.forEach((value, i) => t.add(sample(i + 1, value)))
  return t.snapshot()
}

test('a row whose progress went back is reported once, until it is back at its earlier high', () => {
  const { findings, progressSeen } = track(
    // undefined: the row showed no readable progress in that sample.
    [10, 25, 25, 0, undefined, 5, 20, 30, 35],
    [fake({ name: 'resume', atMs: 380 })],
  )
  assert.equal(progressSeen, true)
  const [finding] = /** @type {ProgressWentBackFinding[]} */ (findings)
  assert.equal(findings.length, 1)
  assert.equal(finding.code, 'PROGRESS_WENT_BACK')
  assert.equal(finding.kind, 'observation')
  assert.equal(finding.basis, 'LOWER_THAN_EARLIER_SAMPLE')
  assert.equal(finding.row, 'second')
  assert.equal(finding.from, 25)
  assert.equal(finding.to, 0)
  assert.deepEqual(finding.firstSeenMs, [400, 450])
  assert.equal(finding.lastSeenMs, 750)
  assert.equal(finding.samples, 3)
  assert.equal(finding.recoveredByMs, 850)
  assert.deepEqual(finding.afterAction, {
    name: 'resume',
    atMs: 380,
    seenAfterActionMs: [20, 70],
  })
  assert.equal(
    finding.summary,
    'Row ‘second’ went back from 25% to 0% in 3 samples from 0.4–0.5 s to 0.8 s; back at 25% or more by 0.9 s; first seen 0.0–0.1 s after action ‘resume’.',
  )
})

test('progress that keeps rising, or starts lower after the row left the region, is not reported', () => {
  const steady = track([0, 10, 10, 50, 100])
  assert.deepEqual(steady.findings, [])
  // null: the row was missing from that sample, so it starts over when it comes back.
  const restarted = track([80, 100, null, 0, 10])
  assert.deepEqual(restarted.findings, [])
})

test('a row still below its earlier high when last seen says so', () => {
  const { findings } = track([40, 60, 10, 15, null, 70])
  const [finding] = /** @type {ProgressWentBackFinding[]} */ (findings)
  assert.equal(findings.length, 1)
  assert.equal(finding.recoveredByMs, null)
  assert.equal(finding.afterAction, null)
  assert.equal(
    finding.summary,
    'Row ‘second’ went back from 60% to 10% in 2 samples from 0.3–0.4 s to 0.5 s; still below 60% when last seen.',
  )
})

test('progress is not tracked unless rows.progress is configured', () => {
  const t = new RowTracker(
    fake({
      rows: { states: [] },
      lagThresholdMs: 1000,
      minUnchangedReads: 2,
    }),
  )
  ;[50, 0].forEach((value, i) => t.add(sample(i + 1, value)))
  const { findings, progressSeen } = t.snapshot()
  assert.deepEqual(findings, [])
  assert.equal(progressSeen, false)
  assert.equal(track([undefined, undefined]).progressSeen, false)
})

test('progress alone adds no timeline event, so a moving bar cannot fill the timeline', () => {
  const endpoint = 'http://127.0.0.1:1/api/downloads'
  const recorder = new ObservationRecorder(
    observationConfig({
      transport: 'http',
      endpoint,
      regionSelector: '#downloads',
      contentSelector: 'li',
      rows: { selector: 'li', progress: 'progress' },
    }),
  )
  const reads = {
    startedAt: 0,
    capturedAt: 0,
    channels: {
      [endpoint]: {
        calls: 0,
        successes: 0,
        errors: 0,
        pending: 0,
        firstReadAt: null,
        lastReadAt: null,
        firstCompletedAt: null,
        lastCompletedAt: null,
        lastSuccessAt: null,
      },
    },
  }
  recorder.openInterval(reads, 0)
  for (let i = 0; i < 5; i++)
    recorder.addSample(
      fake({
        before: reads,
        after: reads,
        fromMs: i * 100,
        ui: { visible: true },
        rows: {
          truncated: false,
          items: [{ row: 'download', state: 'none', progress: i * 10 }],
        },
        actions: [],
        phases: {},
      }),
      { elapsed: () => i * 100 + 50, startedEpoch: 0 },
      0,
    )
  assert.equal(recorder.report.timeline.length, 1)
  assert.deepEqual(recorder.report.timeline[0].rows.items, [
    { row: 'download', state: 'none', progress: 0 },
  ])
})
