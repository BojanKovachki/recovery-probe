import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { probeRecovery, withFault } from '../src/index.mjs';
import { startDemoServer } from '../examples/demo-server.mjs';

let browser;
let server;
before(async () => {
  browser = await chromium.launch({ headless: true });
  server = await startDemoServer();
});
after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});
const config = (variant) => ({ name: variant, url: `${server.url}/${variant}`, requestPattern: '**/api/profile', readySelector: '#profile', retrySelector: '#retry', timeoutMs: 1000 });

test('normal tests miss a recovery defect; each fault reveals it; corrected app passes', async () => {
  const broken = await probeRecovery(browser, config('broken'));
  const fixed = await probeRecovery(browser, config('fixed'));
  assert.equal(broken.results[0].outcome, 'pass');
  assert.deepEqual(broken.results.slice(1).map(row => row.outcome), ['fail', 'fail', 'fail']);
  assert.ok(broken.results.slice(1).every(row => row.applied === 1 && row.code === 'RECOVERY_ASSERTION_FAILED'));
  assert.ok(fixed.ok);
  assert.ok(fixed.results.slice(1).every(row => row.applied === 1));
});

test('an unreachable or incorrect baseline is inconclusive and faults are skipped', async () => {
  const result = await probeRecovery(browser, { ...config('fixed'), readySelector: '#does-not-exist', timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].code, 'BASELINE_FAILED');
  assert.ok(result.results.slice(1).every(row => row.outcome === 'skipped'));
});

test('a successful assertion cannot hide an injection that never happened', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await assert.rejects(
      withFault(page, { match: '**/wrong-endpoint', kind: 'http-error' }, async () => {
        await page.goto(`${server.url}/fixed`);
        await page.locator('#profile').waitFor();
      }),
      error => error.code === 'FAULT_NOT_TRIGGERED' && error.stats.applied === 0,
    );
  } finally { await context.close(); }
});

test('fault count is bounded; other methods and existing route mocks survive cleanup', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.url}/fixed`);
    await page.locator('#profile').waitFor();
    await page.route('**/api/profile', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"name":"existing mock"}' }));
    const stats = await withFault(page, { match: '**/api/profile', kind: 'http-error' }, async () => {
      const observed = await page.evaluate(async () => {
        const post = await fetch('/api/profile', { method: 'POST' });
        const first = await fetch('/api/profile');
        const second = await fetch('/api/profile');
        return [post.status, first.status, second.status, (await second.json()).name];
      });
      assert.deepEqual(observed, [200, 503, 200, 'existing mock']);
    });
    assert.equal(stats.applied, 1);
    assert.deepEqual(await page.evaluate(async () => (await fetch('/api/profile')).json()), { name: 'existing mock' });
  } finally { await context.close(); }
});

test('parallel requests receive exactly the configured number of faults', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.url}/fixed`);
    await page.locator('#profile').waitFor();
    const stats = await withFault(page, { match: '**/api/profile', kind: 'http-error', count: 2 }, async () => {
      const statuses = await page.evaluate(async () => Promise.all(Array.from({ length: 5 }, async () => (await fetch('/api/profile')).status)));
      assert.equal(statuses.filter(status => status === 503).length, 2);
      assert.equal(statuses.filter(status => status === 200).length, 3);
    });
    assert.equal(stats.applied, 2);
  } finally { await context.close(); }
});

test('route cleanup runs even when the user assertion fails', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.url}/fixed`);
    await page.locator('#profile').waitFor();
    await assert.rejects(withFault(page, { match: '**/api/profile', kind: 'http-error' }, async () => {
      await page.evaluate(() => fetch('/api/profile').then(response => response.status));
      throw new Error('intentional assertion failure');
    }), error => error.code === 'RECOVERY_ASSERTION_FAILED');
    assert.equal(await page.evaluate(() => fetch('/api/profile').then(response => response.status)), 200);
  } finally { await context.close(); }
});

test('invalid configurations are rejected before requests are intercepted', async () => {
  await assert.rejects(withFault(null, { match: '**/*', kind: 'http-error', count: 0 }, async () => {}), /count/);
  await assert.rejects(withFault(null, { match: '**/*', kind: 'http-error', status: 200 }, async () => {}), /status/);
  await assert.rejects(withFault(null, { match: '**/*', kind: 'unknown' }, async () => {}), /Unsupported/);
});
