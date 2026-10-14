import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { observationConfig, runObservation, httpObservationAdapter } from '../src/observe.mjs';

let browser, server, origin;
before(async () => {
  const html = await readFile(new URL('./fixtures/cache.html', import.meta.url));
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/items') {
      setTimeout(() => {
        response.writeHead(url.searchParams.get('fail') === 'true' ? 503 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([`synthetic-${url.searchParams.get('identity')}-private-value`]));
      }, 300);
    } else { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
const config = extra => observationConfig({ transport: 'http', endpoint: origin + '/api/items', regionSelector: '#records-region', contentSelector: 'li', sampleMs: 50, observationMs: 900, ...extra });
async function prepared(fixed = false) {
  const page = await browser.newPage();
  await page.goto(origin + (fixed ? '/?fixed=true' : '/'));
  await page.click('#items'); await page.locator('#records li').waitFor();
  await page.click('#home');
  return page;
}

test('fresh cached content is observed without a reload or read; absence during navigation is allowed', async () => {
  const page = await prepared();
  try {
    const nonce = await page.evaluate(() => window.fixtureNonce);
    let opened = false;
    const c = config();
    const report = await runObservation(page, c, httpObservationAdapter(page, c), { onSample: async () => { if (!opened) { opened = true; await page.click('#items'); } } });
    assert.equal(report.captureComplete, true, JSON.stringify(report));
    assert.equal(report.snapshot.channels[c.endpoint].calls, 0);
    assert.equal(report.timeline[0].ui.presence, 'absent');
    assert.equal(report.findings[0].code, 'CONTENT_BEFORE_READ');
    assert.equal(report.findings[0].basis, 'NO_READ_OBSERVED_IN_INTERVAL');
    assert.equal(report.findings[0].lastCompletionAgeMs, null);
    assert.equal(report.coverage.historyBeforeCapture, 'unknown');
    assert.equal(await page.evaluate(() => window.fixtureNonce), nonce);
    assert.ok(!JSON.stringify(report).includes('synthetic-alpha-private-value'));
    assert.equal(report.sampling.completedSamples, report.samples);
    assert.equal(report.sampling.startToStart.count, report.samples - 1);
    assert.ok(report.samples > report.timeline.length);
    assert.match(report.findings[0].summary, /without a new selected read/);
    assert.equal(report.cleanup, 'complete');
  } finally { await page.close(); }
});

test('interval markers retain read history while measuring zero reads on a cached return visit', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    let phase = 0, mark = false;
    const c = config({ observationMs: 1300 });
    const report = await runObservation(page, c, httpObservationAdapter(page, c), {
      takeMarker: () => { const value = mark; mark = false; return value; },
      onSample: async e => {
        if (phase === 0) { phase = 1; await page.click('#items'); }
        else if (phase === 1 && e.ui.contentCount > 0 && e.reads.successes === 1) { phase = 2; await page.click('#home'); mark = true; }
        else if (phase === 2 && e.interval === 2) { phase = 3; await page.click('#items'); }
      },
    });
    assert.equal(report.captureComplete, true, JSON.stringify(report));
    assert.equal(report.intervals.length, 2);
    assert.equal(report.intervals[0].reads.calls, 1);
    assert.equal(report.intervals[1].reads.calls, 0);
    assert.ok(report.intervals[1].firstContent.lastCompletionAgeMs >= 0);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].interval, 2);
  } finally { await page.close(); }
});

test('synthetic identity change: stale content before completion and after failure remains evidence, not an ownership verdict', async () => {
  for (const fail of [false, true]) {
    const page = await prepared();
    try {
      await page.click('#switch'); await page.click('#expire'); if (fail) await page.click('#fail');
      let opened = false;
      const c = config();
      const report = await runObservation(page, c, httpObservationAdapter(page, c), { onSample: async () => { if (!opened) { opened = true; await page.click('#items'); } } });
      assert.equal(report.captureComplete, true, JSON.stringify(report));
      assert.equal(report.findings[0].basis, 'NO_COMPLETION_OBSERVED_IN_INTERVAL');
      assert.equal(report.intervals[0].reads.calls, 1);
      assert.equal(report.intervals[0].reads.errors, fail ? 1 : 0);
      assert.equal(await page.locator('#records li').innerText(), `synthetic-${fail ? 'alpha' : 'beta'}-private-value`);
      assert.ok(report.findings.every(f => f.kind === 'observation'));
      assert.ok(!JSON.stringify(report).includes('private-value'));
    } finally { await page.close(); }
  }
});

test('synthetic fresh cross-identity cache reuse is visible; a per-identity key control reads before rendering', async () => {
  for (const fixed of [false, true]) {
    const page = await prepared(fixed);
    try {
      await page.click('#switch');
      let opened = false;
      const c = config();
      const report = await runObservation(page, c, httpObservationAdapter(page, c), { onSample: async () => { if (!opened) { opened = true; await page.click('#items'); } } });
      assert.equal(report.captureComplete, true, JSON.stringify(report));
      assert.equal(report.intervals[0].reads.calls, fixed ? 1 : 0);
      assert.equal(report.findings.length, fixed ? 0 : 1);
      assert.equal(await page.locator('#records li').innerText(), `synthetic-${fixed ? 'beta' : 'alpha'}-private-value`);
    } finally { await page.close(); }
  }
});

test('interruption and document replacement retain partial evidence and detach listeners', async () => {
  for (const replace of [false, true]) {
    const page = await prepared();
    try {
      const c = config(); const controller = new AbortController(); let changed = false;
      const initial = page.listenerCount('request');
      const report = await runObservation(page, c, httpObservationAdapter(page, c), { signal: controller.signal, onSample: async () => {
        if (changed) return; changed = true;
        if (replace) await page.reload(); else controller.abort();
      } });
      assert.equal(report.captureComplete, false);
      assert.equal(report.status, replace ? 'incomplete' : 'interrupted');
      if (replace) assert.match(report.error, /DOCUMENT_REPLACED/);
      assert.ok(report.samples > 0);
      assert.equal(report.cleanup, 'complete');
      assert.equal(page.listenerCount('request'), initial);
    } finally { await page.close(); }
  }
});

test('missing content markers are coverage gaps, not successful health checks', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const c = config({ observationMs: 500 });
    const report = await runObservation(page, c, httpObservationAdapter(page, c));
    assert.equal(report.status, 'complete');
    assert.equal(report.captureComplete, false);
    assert.ok(report.coverage.gaps.includes('CONTENT_MARKER_NOT_OBSERVED'));
    assert.equal(report.findings.length, 0);
  } finally { await page.close(); }
});
