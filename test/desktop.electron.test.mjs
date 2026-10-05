import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { startDemoServer } from '../examples/demo-server.mjs';
import { checkDesktop, connectDesktop, discoverDesktop, selectDesktopPage } from '../src/desktop.mjs';
const exec = promisify(execFile);
let app; let browser; let page; let server; let cdp;
before(async () => {
  server = await startDemoServer();
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  cdp = `http://127.0.0.1:${port}`;
  app = await electron.launch({ args: ['--no-sandbox', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, fileURLToPath(new URL('./fixtures/electron/main.cjs', import.meta.url))], env: { ...process.env, RECOVERY_PROBE_FIXTURE_URL: `${server.url}/fixed` } });
  await app.firstWindow();
  browser = await connectDesktop(cdp);
  page = selectDesktopPage(browser, { pageUrl: `${server.url}/fixed` });
  await page.locator('#profile').waitFor();
}, { timeout: 30000 });
after(async () => { if (browser) await browser.close(); if (app) await app.close(); if (server) await server.close(); });
const config = (variant, extra = {}) => ({ cdp, pageUrl: `${server.url}/${variant}`, endpoint: `${server.url}/api/profile`, readySelector: '#profile', readyText: 'Synthetic Example', retrySelector: '#retry', timeoutMs: 1500, ...extra });

test('connects to real Electron, preserves preload, discovers JSON requests without injecting', async () => {
  assert.equal(await page.evaluate(() => window.recoveryProbeFixture.kind), 'electron-preload');
  const discovery = await discoverDesktop(page, { durationMs: 200 });
  assert.deepEqual(discovery.endpoints.map(e => e.endpoint), [`${server.url}/api/profile`]);
  assert.equal(await page.locator('#profile').innerText(), 'Synthetic Example');
});
test('catches the stuck retry in Electron for all three faults, and reload rescues it', async () => {
  await page.goto(`${server.url}/broken`);
  const report = await checkDesktop(page, config('broken'), { onFailure: async (target, row) => { console.log('BROKEN_DIAGNOSTIC', JSON.stringify({ row, status: await target.locator('#status').innerText(), retryVisible: await target.locator('#retry').isVisible() })); } });
  assert.equal(report.ok, false);
  assert.deepEqual(report.results.map(r => r.outcome), ['fail', 'fail', 'fail'], JSON.stringify(report));
  assert.ok(report.results.every(r => r.applied === 1 && r.retryClicked && r.successfulResponsesAfterFault === 0));
  assert.equal(report.finalReset, 'healthy');
});
test('corrected Electron app recovers from all faults with subsequent real requests', async () => {
  await page.goto(`${server.url}/fixed`);
  const report = await checkDesktop(page, config('fixed'));
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.results.every(r => r.applied === 1 && r.successfulResponsesAfterFault > 0 && r.retryClicked));
  assert.equal(await page.evaluate(() => window.recoveryProbeFixture.kind), 'electron-preload');
});
test('wrong endpoint and wrong health marker are inconclusive, never app failures', async () => {
  for (const extra of [{ endpoint: `${server.url}/absent` }, { readySelector: '#absent' }]) {
    const report = await checkDesktop(page, config('fixed', { ...extra, timeoutMs: 200 }));
    assert.equal(report.results[0].code, 'BASELINE_FAILED');
    assert.ok(report.results.every(r => r.applied === 0 && r.outcome !== 'fail'));
  }
});
test('unavailable retry action is inconclusive and routing is cleaned up', async () => {
  const report = await checkDesktop(page, config('fixed', { faults: ['http-error'], retrySelector: '#absent', timeoutMs: 200 }));
  assert.equal(report.results[0].code, 'RETRY_ACTION_UNAVAILABLE');
  assert.equal(report.results[0].outcome, 'inconclusive');
  assert.equal(report.finalReset, 'healthy');
  assert.equal(await page.evaluate(() => fetch('/api/profile').then(r => r.status)), 200);
});
test('automatic recovery works without any retry selector', async () => {
  await page.goto(`${server.url}/automatic`);
  const report = await checkDesktop(page, config('automatic', { recovery: 'automatic', retrySelector: undefined }));
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.results.every(r => !r.retryClicked && r.successfulResponsesAfterFault > 0));
});
test('a stale visible marker cannot pass without a successful request after the fault', async () => {
  await page.goto(`${server.url}/stale`);
  const report = await checkDesktop(page, config('stale', { recovery: 'automatic', faults: ['invalid-json'] }));
  assert.equal(report.results[0].applied, 1);
  assert.equal(report.results[0].outcome, 'fail');
  assert.equal(report.results[0].successfulResponsesAfterFault, 0);
});
test('CLI writes useful reports and disconnecting leaves the Electron app alive', async () => {
  await page.goto(`${server.url}/fixed`);
  const dir = await mkdtemp(join(tmpdir(), 'recovery-desktop-cli-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const configPath = join(dir, 'input.json');
    await writeFile(configPath, JSON.stringify(config('fixed', { faults: ['http-error'] })));
    const result = await exec(process.execPath, [fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url)), 'desktop', '--config', configPath, '--out', dir], { timeout: 20000 });
    assert.match(result.stdout, /PASS/);
    assert.equal(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).ok, true);
    assert.match(await readFile(join(dir, 'fix-brief.md'), 'utf8'), /not an automatic diagnosis/);
    assert.match(await readFile(join(dir, 'reproduce.mjs'), 'utf8'), /checkDesktop/);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(await page.evaluate(() => window.recoveryProbeFixture.kind), 'electron-preload');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
