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
  assert.equal(discoveryConfig({ channel: 'read', readyText: 'private filename' }).readyText, undefined);
  assert.throws(() => discoveryConfig({ channel: 'read', observationMs: 60001 }));
});
test('structural loss and value shifts remain separate from semantic interpretation', async () => {
  const { compareRegions } = await import('../src/ipc-observation.mjs');
  const before = summarizeRegion({text:'Heading',images:13,items:0,groups:{cards:13},structure:{a:13,img:13},distributions:{cards:{0:{manager:4,user:17}}}});
  const after = summarizeRegion({text:'Heading',images:0,items:0,groups:{},structure:{},distributions:{}});
  assert.equal(compareRegions(before,after).contentLoss,true);
  assert.equal(classifyObservation({baseline:before,final:after,injected:1,expected:1,recovered:false}).classification,'CONTENT_LOSS');
  const shifted = summarizeRegion({text:'Heading',images:13,items:0,groups:{cards:13},structure:{a:13,img:13},distributions:{cards:{0:{user:21}}}});
  assert.equal(compareRegions(before,shifted).distributionChanges.length,1);
  assert.ok(!JSON.stringify(shifted).includes('user'));
});
