import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  observationMetadata,
  samplingMetrics,
  observationSummary,
  renderObservationReport,
  contentComparisons,
  comparisonFollowUpSummary,
} from '../src/observation-report.mjs'
import { createRequire } from 'node:module'

test('sampling measures actual durations and start cadence, including unchanged samples', () => {
  const metrics = samplingMetrics(100)
  assert.equal(metrics.snapshot().startToStart.meanMs, null)
  metrics.add(10, 210)
  assert.equal(metrics.snapshot().startToStart.count, 0)
  metrics.add(330, 380)
  metrics.add(500, 600)
  const result = metrics.snapshot()
  assert.equal(result.requestedDelayMs, 100)
  assert.deepEqual(result.startToStart, {
    count: 2,
    meanMs: 245,
    minMs: 170,
    maxMs: 320,
  })
  assert.deepEqual(result.sampleDuration, {
    count: 3,
    meanMs: 116.67,
    minMs: 50,
    maxMs: 200,
  })
})

const sample = (
  successes,
  {
    during = 0,
    errors = 0,
    text = 'hash-a',
    count = 1,
    interval = 1,
    truncated = false,
    visible = true,
    presence = 'visible',
  } = {},
) => ({
  interval,
  fromMs: 10,
  toMs: 20,
  ui: {
    presence,
    visible,
    contentCount: count,
    ...(presence === 'visible'
      ? { content: { count, textFingerprint: text, truncated } }
      : {}),
  },
  before: { successes, errors },
  after: { successes: successes + during, errors },
  reads: { calls: successes + errors, pendingAtStart: 0 },
})
test('content comparisons wait for a sample after completion and separate changed, unchanged and failed reads', () => {
  const tracker = contentComparisons()
  assert.deepEqual(tracker.add(sample(0)), [])
  assert.deepEqual(tracker.add(sample(0, { during: 1, text: 'ambiguous' })), [])
  const [same] = tracker.add(sample(1))
  assert.equal(same.result, 'unchanged')
  assert.deepEqual(same.completions, { successes: 1, errors: 0 })
  const [changed] = tracker.add(sample(2, { text: 'hash-b' }))
  assert.equal(changed.result, 'changed')
  const [failed] = tracker.add(sample(2, { errors: 1, text: 'hash-b' }))
  assert.equal(failed.result, 'unchanged')
  assert.deepEqual(failed.completions, { successes: 0, errors: 1 })
})
test('interval return compares last content and unavailable or truncated evidence never becomes unchanged', () => {
  const tracker = contentComparisons()
  tracker.add(sample(1))
  tracker.add(sample(1, { count: 0, presence: 'absent' }))
  const [returned] = tracker.add(sample(1, { interval: 2 }))
  assert.equal(returned.basis, 'INTERVAL_RETURN')
  assert.equal(returned.result, 'unchanged')
  assert.deepEqual(tracker.add(sample(1, { interval: 2 })), [])
  assert.equal(
    tracker.add(sample(2, { interval: 2, truncated: true }))[0].result,
    'unavailable',
  )
  assert.equal(tracker.add(sample(3, { interval: 2 }))[0].result, 'unavailable')
  assert.equal(
    tracker.add(sample(4, { interval: 2, visible: false }))[0].result,
    'unavailable',
  )
})
test('sample phase metrics include repeated samples without leaking timing into content', () => {
  const metrics = samplingMetrics(50)
  metrics.add(0, 10, {
    rendererReadMs: 2.123,
    uiRoundTripMs: 8,
    beforeSnapshotMs: 3,
  })
  metrics.add(60, 75, { rendererReadMs: 4, uiRoundTripMs: 12, ignored: 99 })
  assert.deepEqual(metrics.snapshot().phases.rendererReadMs, {
    count: 2,
    meanMs: 3.06,
    minMs: 2.12,
    maxMs: 4,
  })
  assert.equal(metrics.snapshot().phases.ignored, undefined)
})

test('return follow-up preserves the initial difference, later match, latest divergence and interval boundary', () => {
  const tracker = contentComparisons()
  let clock = 0
  const add = (options) =>
    tracker.add({
      ...sample(0, options),
      fromMs: (clock += 100),
      toMs: clock + 10,
    })
  add({ count: 19 })
  const [returned] = add({ count: 17, interval: 2 })
  assert.match(comparisonFollowUpSummary(returned), /No later sample/)
  add({ count: 19, interval: 2 })
  assert.equal(returned.result, 'changed')
  assert.equal(returned.after.content.count, 17)
  assert.equal(returned.followUp.firstBaselineMatch.fromMs, 300)
  assert.equal(returned.followUp.latest.result, 'unchanged')
  assert.match(
    returned.followUp.summary,
    /Initially different; a later sample matched/,
  )
  add({ count: 19, interval: 2 }) // Include unchanged samples omitted from the timeline.
  add({ count: 18, interval: 2 })
  assert.equal(returned.followUp.samples, 3)
  assert.equal(returned.followUp.latest.result, 'changed')
  assert.match(returned.followUp.summary, /Latest follow-up sample .*changed/)
  const ended = JSON.stringify(returned)
  add({ count: 19, interval: 3 })
  assert.equal(JSON.stringify(returned), ended)
})

test('hidden, absent and truncated follow-up samples cannot establish a baseline match', () => {
  const tracker = contentComparisons()
  tracker.add(sample(0))
  const [comparison] = tracker.add(sample(1, { text: 'different' }))
  for (const options of [
    { visible: false },
    { presence: 'absent', count: 0 },
    { truncated: true },
  ])
    tracker.add(sample(1, options))
  assert.equal(comparison.followUp.samples, 3)
  assert.equal(comparison.followUp.unavailableSamples, 3)
  assert.equal(comparison.followUp.comparableSamples, 0)
  assert.equal(comparison.followUp.firstBaselineMatch, null)
  assert.equal(comparison.followUp.latest.result, 'unavailable')
  tracker.add(sample(1))
  assert.equal(comparison.followUp.latest.result, 'unchanged')
  assert.equal(comparison.followUp.comparableSamples, 1)
  tracker.add(sample(1, { visible: false }))
  assert.equal(comparison.followUp.latest.result, 'unavailable')
  assert.ok(comparison.followUp.firstBaselineMatch)
})

test('an unchanged first comparison can diverge later; an incomplete baseline stays unavailable', () => {
  const tracker = contentComparisons()
  tracker.add(sample(0))
  const [same] = tracker.add(sample(1))
  tracker.add(sample(1, { text: 'different' }))
  assert.equal(same.result, 'unchanged')
  assert.equal(same.followUp.latest.result, 'changed')
  assert.equal(same.followUp.firstBaselineMatch, null)
  tracker.add(sample(1, { truncated: true }))
  const [unknown] = tracker.add(sample(2))
  tracker.add(sample(2))
  assert.equal(unknown.result, 'unavailable')
  assert.equal(unknown.followUp.latest.result, 'unavailable')
})

test('follow-up tracking is bounded by the report comparison cap', () => {
  const tracker = contentComparisons()
  tracker.add(sample(0))
  let first, last
  for (let i = 1; i <= 1001; i++) {
    ;[last] = tracker.add(sample(i))
    first ??= last
  }
  assert.equal(first.followUp.samples, 1000)
  assert.equal(last.followUp, undefined)
})
test('report explanations distinguish no read from no completion and preserve safe HTML', () => {
  const noRead = {
    code: 'CONTENT_BEFORE_READ',
    basis: 'NO_READ_OBSERVED_IN_INTERVAL',
    interval: 1,
  }
  const pending = { ...noRead, basis: 'NO_COMPLETION_OBSERVED_IN_INTERVAL' }
  assert.match(observationSummary(noRead), /without a new selected read/)
  assert.match(
    observationSummary(pending),
    /before any selected read completed/,
  )
  const metadata = observationMetadata()
  assert.equal(
    metadata.recoveryProbeVersion,
    createRequire(import.meta.url)('../package.json').version,
  )
  const html = renderObservationReport({
    metadata,
    status: 'incomplete',
    error: '<script>bad()</script>',
    intervals: [],
    findings: [noRead, pending],
    sampling: samplingMetrics(100).snapshot(),
  })
  assert.ok(!html.includes('<script>'))
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /unavailable/)
  const tracker = contentComparisons()
  tracker.add(sample(0))
  const [comparison] = tracker.add(sample(1, { text: 'different' }))
  tracker.add(sample(1))
  const withComparison = renderObservationReport({
    metadata,
    status: 'complete',
    intervals: [],
    findings: [],
    comparisons: [comparison],
  })
  assert.match(withComparison, /Initially different; a later sample matched/)
  assert.match(withComparison, /Latest follow-up sample/)
  assert.equal(comparisonFollowUpSummary({}), '')
})
