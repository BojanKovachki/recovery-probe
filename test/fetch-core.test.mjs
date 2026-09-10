import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFaultFetch } from '../src/index.mjs';
import { startDemoServer } from '../examples/demo-server.mjs';
import { runCoreDemo } from '../examples/core-demo.mjs';

let server;
let endpoint;
before(async () => { server = await startDemoServer(); endpoint = `${server.url}/api/profile`; });
after(async () => { if (server) await server.close(); });

test('HTTP-backed control comparison exposes the recovery defect and verifies the correction', async () => {
  const report = await runCoreDemo();
  assert.equal(report.expectedDemonstrationVerified, true);
  assert.equal(report.apps[0].results[0].outcome, 'pass');
  assert.equal(report.apps[1].results[0].outcome, 'pass');
  assert.ok(report.apps[0].results.slice(1).every(row => row.outcome === 'fail' && row.injected === 1));
  assert.ok(report.apps[1].results.slice(1).every(row => row.outcome === 'pass' && row.injected === 1));
});

test('exact URL matching leaves other routes, query strings and methods intact', async () => {
  const p = createFaultFetch(fetch, { url: endpoint, kind: 'http-error' });
  assert.equal((await p.fetch(`${endpoint}?different=1`)).status, 200);
  assert.equal((await p.fetch(`${server.url}/does-not-exist`)).status, 404);
  assert.equal((await p.fetch(endpoint, { method: 'POST' })).status, 200);
  assert.equal((await p.fetch(endpoint)).status, 503);
  assert.equal((await p.fetch(endpoint)).status, 200);
  assert.equal(p.assertApplied().matchingRequests, 2);
});

test('concurrent traffic consumes only the configured count and then reaches the real server', async () => {
  const p = createFaultFetch(fetch, { url: endpoint, kind: 'http-error', count: 2 });
  const responses = await Promise.all(Array.from({ length: 6 }, () => p.fetch(endpoint)));
  assert.equal(responses.filter(r => r.status === 503).length, 2);
  assert.equal(responses.filter(r => r.status === 200).length, 4);
  assert.equal(p.assertApplied().applied, 2);
});

test('unused and partially consumed faults cannot be counted as successful checks', async () => {
  const p = createFaultFetch(fetch, { url: endpoint, kind: 'http-error', count: 2 });
  assert.throws(() => p.assertApplied(), e => e.code === 'FAULT_NOT_TRIGGERED');
  await p.fetch(endpoint);
  assert.throws(() => p.assertApplied(), e => e.code === 'FAULT_NOT_TRIGGERED' && e.stats.applied === 1);
});

test('interrupted requests and malformed JSON produce different real fetch failure surfaces', async () => {
  const interrupted = createFaultFetch(fetch, { url: endpoint, kind: 'connection-failure' });
  await assert.rejects(interrupted.fetch(endpoint), TypeError);
  assert.equal((await interrupted.fetch(endpoint)).status, 200);
  interrupted.assertApplied();
  const malformed = createFaultFetch(fetch, { url: endpoint, kind: 'invalid-json' });
  const response = await malformed.fetch(endpoint);
  assert.equal(response.status, 200);
  await assert.rejects(response.json(), SyntaxError);
  assert.equal((await (await malformed.fetch(endpoint)).json()).name, 'Synthetic Example');
  malformed.assertApplied();
});

test('Request inputs and explicit method overrides are preserved', async () => {
  const p = createFaultFetch(fetch, { url: endpoint, kind: 'http-error', method: 'POST', status: 429 });
  assert.equal((await p.fetch(new Request(endpoint))).status, 200);
  assert.equal((await p.fetch(new Request(endpoint), { method: 'post' })).status, 429);
  assert.equal((await (await p.fetch(new Request(endpoint, { method: 'POST' }))).json()).method, 'POST');
  p.assertApplied();
});

test('already aborted requests keep cancellation semantics and do not consume a fault', async () => {
  const p = createFaultFetch(fetch, { url: endpoint, kind: 'http-error' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(p.fetch(endpoint, { signal: controller.signal }), e => e.name === 'AbortError');
  assert.equal(p.summary().applied, 0);
  assert.equal((await p.fetch(endpoint)).status, 503);
  p.assertApplied();
});

test('probes are isolated and never replace global fetch', async () => {
  const original = fetch;
  const first = createFaultFetch(fetch, { url: endpoint, kind: 'http-error' });
  const second = createFaultFetch(fetch, { url: endpoint, kind: 'http-error' });
  assert.equal((await first.fetch(endpoint)).status, 503);
  assert.equal(second.summary().applied, 0);
  assert.equal((await second.fetch(endpoint)).status, 503);
  assert.equal(fetch, original);
  assert.equal((await fetch(endpoint)).status, 200);
});

test('invalid options fail before any underlying request', () => {
  const impossible = () => { throw new Error('must not be called'); };
  assert.throws(() => createFaultFetch(impossible, { url: endpoint, kind: 'http-error', count: 0 }), /count/);
  assert.throws(() => createFaultFetch(impossible, { url: endpoint, kind: 'http-error', status: 200 }), /status/);
  assert.throws(() => createFaultFetch(impossible, { url: endpoint, kind: 'unknown' }), /Unsupported/);
  assert.throws(() => createFaultFetch(impossible, { url: 'file:///tmp/example', kind: 'http-error' }), /HTTP/);
});
