import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationMetadata, samplingMetrics, observationSummary, renderObservationReport } from '../src/observation-report.mjs';
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
