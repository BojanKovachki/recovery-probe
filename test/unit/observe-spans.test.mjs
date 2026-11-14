import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  relateSpans,
  SpanRecorder,
  spansConfig,
  spansOf,
} from '../../dist/workflows/observe/spans.mjs'
import {
  spanNotes,
  spanSummary,
} from '../../dist/workflows/observe/summaries.mjs'
import { fake } from '../helpers/fake.mjs'

const startedEpoch = 1_700_000_000_000
const nanos = (ms) =>
  String(BigInt(startedEpoch) * 1_000_000n + BigInt(Math.round(ms * 1e6)))
const config = spansConfig({
  names: ['LoadTime *'],
  attributes: ['load_time.outcome', 'load_time.items'],
})

test('spans config names the spans to list and the attribute values to keep', () => {
  assert.deepEqual(spansConfig({ names: ['LoadTime *'] }), {
    names: ['LoadTime *'],
    attributes: [],
  })
  for (const [spans, message] of [
    [{ names: [] }, /names must list 1–20/],
    [{ names: ['ok'], attributes: [''] }, /text of 1–100 characters/],
    [{ names: ['ok'], values: ['x'] }, /Unsupported spans property: values/],
  ])
    assert.throws(() => spansConfig(spans), message)
})

test('lists the matching spans of an OTLP JSON export with only the kept attributes', () => {
  const spans = spansOf(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'LoadTime community',
                  startTimeUnixNano: nanos(1000.25),
                  endTimeUnixNano: nanos(2952),
                  status: { code: 2 },
                  attributes: [
                    {
                      key: 'load_time.outcome',
                      value: { stringValue: 'failure' },
                    },
                    { key: 'load_time.items', value: { intValue: '13' } },
                    {
                      key: 'Email',
                      value: { stringValue: 'person@example.test' },
                    },
                  ],
                },
                { name: 'GET /api/items', startTimeUnixNano: nanos(0) },
              ],
            },
          ],
        },
      ],
    },
    config,
    startedEpoch,
  )
  assert.deepEqual(spans, [
    {
      name: 'LoadTime community',
      startMs: 1000.25,
      endMs: 2952,
      durationMs: 1951.75,
      status: 'error',
      attributes: { 'load_time.outcome': 'failure', 'load_time.items': 13 },
    },
  ])
  assert.throws(
    () => spansOf({ spans: [] }, config, startedEpoch),
    /not an OTLP JSON export/,
  )
})

test('the recorder reads trace exports until stopped, keeping the first 500 matching spans', () => {
  /** @type {((request: object) => void) | undefined} */
  let listener
  const page = fake({
    on: (_event, onRequest) => (listener = onRequest),
    off: (_event, onRequest) => {
      if (listener === onRequest) listener = undefined
    },
  })
  const request = (method, url, postData) =>
    fake({ method: () => method, url: () => url, postData: () => postData })
  const otlp = (count) =>
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: Array.from({ length: count }, () => ({
                name: 'LoadTime x',
                startTimeUnixNano: nanos(0),
                endTimeUnixNano: nanos(10),
              })),
            },
          ],
        },
      ],
    })
  const recorder = new SpanRecorder(page, config)
  recorder.start(startedEpoch)
  listener?.(request('POST', 'https://alloy.example/otlp/v1/traces', otlp(499)))
  listener?.(request('POST', 'https://alloy.example/otlp/v1/traces', otlp(3)))
  listener?.(request('POST', 'https://alloy.example/v1/traces', '\u0000proto'))
  listener?.(request('GET', 'https://alloy.example/v1/traces', otlp(1)))
  listener?.(request('POST', 'https://api.example/v1/items', otlp(1)))
  const result = recorder.stop()
  assert.equal(listener, undefined, 'stops listening')
  assert.equal(result.spans.length, 500)
  assert.equal(result.droppedSpans, 2)
  assert.equal(result.unreadableExports, 1)
  assert.deepEqual(spanNotes(result), [
    '1 span export(s) were not OTLP JSON.',
    '2 more matching span(s) were not listed.',
  ])
})

test('places each span in its interval and times it against the fully loaded content', () => {
  const span = (startMs, endMs) =>
    fake({
      name: 'LoadTime x',
      startMs,
      endMs,
      durationMs: endMs - startMs,
      status: 'unset',
      attributes: {},
    })
  const early = span(1100, 1450)
  const during = span(1150, 1550)
  const late = span(1200, 1650)
  const before = span(500, 900)
  // Interval 3's content was already loaded at its first sample: only "after" can be told.
  const alreadyLoaded = span(3010, 3050)
  const afterAlreadyLoaded = span(3020, 3200)
  const spans = [early, during, late, before, alreadyLoaded, afterAlreadyLoaded]
  /** @type {import('../../dist/workflows/observe/report.mjs').ObservationReport} */
  const report = fake({
    intervals: [
      fake({ index: 1, startMs: 0, contentLoaded: null }),
      fake({
        index: 2,
        startMs: 1000,
        contentLoaded: fake({ notLoadedAtMs: 1500, toMs: 1600 }),
      }),
      fake({
        index: 3,
        startMs: 3000,
        contentLoaded: fake({ notLoadedAtMs: null, toMs: 3100 }),
      }),
    ],
    spans: { spans, unreadableExports: 0, droppedSpans: 0 },
  })
  relateSpans(report)
  assert.deepEqual(
    spans.map((s) => [s.interval, s.vsContentLoaded]),
    [
      [2, { ended: 'before', byMs: 50 }],
      [2, { ended: 'within', byMs: 0 }],
      [2, { ended: 'after', byMs: 50 }],
      [1, undefined],
      [3, undefined],
      [3, { ended: 'after', byMs: 100 }],
    ],
  )
  assert.equal(
    spanSummary(late),
    'LoadTime x (interval 2): 450 ms; ended 50 ms after the content fully loaded',
  )
  assert.equal(
    spanSummary(during),
    'LoadTime x (interval 2): 400 ms; ended as the content fully loaded, between two samples',
  )
  assert.equal(
    spanSummary({
      ...early,
      status: 'error',
      attributes: { 'load_time.failure': 'image' },
    }),
    'LoadTime x (interval 2): 350 ms, error; ended 50 ms before the content fully loaded; load_time.failure=image',
  )
})
