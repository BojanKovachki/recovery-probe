import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationMetadata, samplingMetrics, observationSummary, renderObservationReport, contentComparisons } from '../src/observation-report.mjs';
import { createRequire } from 'node:module';

test('sampling measures actual durations and start cadence, including unchanged samples', () => {
  const metrics = samplingMetrics(100);
  assert.equal(metrics.snapshot().startToStart.meanMs, null);
  metrics.add(10, 210);
  assert.equal(metrics.snapshot().startToStart.count, 0);
  metrics.add(330, 380); metrics.add(500, 600);
  const result = metrics.snapshot();
  assert.equal(result.requestedDelayMs, 100);
  assert.deepEqual(result.startToStart, { count: 2, meanMs: 245, minMs: 170, maxMs: 320 });
  assert.deepEqual(result.sampleDuration, { count: 3, meanMs: 116.67, minMs: 50, maxMs: 200 });
});

const sample = (successes, { during = 0, errors = 0, text = 'hash-a', count = 1, interval = 1, truncated = false, visible = true, presence = 'visible' } = {}) => ({
  interval, fromMs: 10, toMs: 20, ui: { presence, visible, contentCount: count,
    ...(presence === 'visible' ? { content: { count, textFingerprint: text, truncated } } : {}) },
  before: { successes, errors }, after: { successes: successes + during, errors }, reads: { calls: successes + errors, pendingAtStart: 0 },
});
test('content comparisons wait for a sample after completion and separate changed, unchanged and failed reads', () => {
  const tracker = contentComparisons();
  assert.deepEqual(tracker.add(sample(0)), []);
  assert.deepEqual(tracker.add(sample(0, { during: 1, text: 'ambiguous' })), []);
  const [same] = tracker.add(sample(1));
  assert.equal(same.result, 'unchanged');
  assert.deepEqual(same.completions, { successes: 1, errors: 0 });
  const [changed] = tracker.add(sample(2, { text: 'hash-b' }));
  assert.equal(changed.result, 'changed');
  const [failed] = tracker.add(sample(2, { errors: 1, text: 'hash-b' }));
  assert.equal(failed.result, 'unchanged');
  assert.deepEqual(failed.completions, { successes: 0, errors: 1 });
});
test('interval return compares last content and unavailable or truncated evidence never becomes unchanged', () => {
  const tracker = contentComparisons();
  tracker.add(sample(1));
  tracker.add(sample(1, { count: 0, presence: 'absent' }));
  const [returned] = tracker.add(sample(1, { interval: 2 }));
  assert.equal(returned.basis, 'INTERVAL_RETURN');
  assert.equal(returned.result, 'unchanged');
  assert.deepEqual(tracker.add(sample(1, { interval: 2 })), []);
  assert.equal(tracker.add(sample(2, { interval: 2, truncated: true }))[0].result, 'unavailable');
  assert.equal(tracker.add(sample(3, { interval: 2 }))[0].result, 'unavailable');
  assert.equal(tracker.add(sample(4, { interval: 2, visible: false }))[0].result, 'unavailable');
});
test('sample phase metrics include repeated samples without leaking timing into content', () => {
  const metrics = samplingMetrics(50);
  metrics.add(0, 10, { rendererReadMs: 2.123, uiRoundTripMs: 8, beforeSnapshotMs: 3 });
  metrics.add(60, 75, { rendererReadMs: 4, uiRoundTripMs: 12, ignored: 99 });
  assert.deepEqual(metrics.snapshot().phases.rendererReadMs, { count: 2, meanMs: 3.06, minMs: 2.12, maxMs: 4 });
  assert.equal(metrics.snapshot().phases.ignored, undefined);
});
test('report explanations distinguish no read from no completion and preserve safe HTML', () => {
  const noRead = { code: 'CONTENT_BEFORE_READ', basis: 'NO_READ_OBSERVED_IN_INTERVAL', interval: 1 };
  const pending = { ...noRead, basis: 'NO_COMPLETION_OBSERVED_IN_INTERVAL' };
  assert.match(observationSummary(noRead), /without a new selected read/);
  assert.match(observationSummary(pending), /before any selected read completed/);
  const metadata = observationMetadata();
  assert.equal(metadata.recoveryProbeVersion, createRequire(import.meta.url)('../package.json').version);
  const html = renderObservationReport({ metadata, status: 'incomplete', error: '<script>bad()</script>', intervals: [], findings: [noRead, pending], sampling: samplingMetrics(100).snapshot() });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /unavailable/);
});
