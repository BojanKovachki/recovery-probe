import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservation, summarizeRegion } from '../src/ipc-observation.mjs';
import { discoveryConfig } from '../src/ipc-discover.mjs';
const baseline = { textLength: 20, empty: false };
const assess = overrides => classifyObservation({ baseline, final: { empty: true }, injected: 2, expected: 2, recovered: false, ...overrides });
test('differential leads distinguish silent failure from legitimate empty, explicit errors and incomplete faults', () => {
  assert.equal(assess({}).classification, 'SILENT_EMPTY');
  assert.equal(assess({ baseline: { ...baseline, empty: true } }).kind, 'decision-needed');
  assert.equal(assess({ final: { empty: true, error: true } }).classification, 'ERROR_OR_RETRY_SHOWN');
  assert.equal(assess({ final: { loading: true } }).classification, 'LOADING_AT_DEADLINE');
  assert.equal(assess({ injected: 1 }).kind, 'inconclusive');
  assert.equal(assess({ recovered: true }).classification, 'RECOVERED');
});
test('UI summaries omit raw text and discovery validates bounds without asking for selectors', () => {
  const summary = summarizeRegion({ text: 'private filename', empty: false });
  assert.equal(summary.text, undefined);
  assert.ok(!JSON.stringify(summary).includes('private filename'));
  assert.equal(discoveryConfig({ channel: 'read' }).repeats, 3);
  assert.throws(() => discoveryConfig({ channel: 'read', observationMs: 60001 }));
});
