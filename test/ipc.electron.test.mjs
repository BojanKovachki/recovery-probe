import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './repair-fixture.mjs';
import { connectDesktop, desktopPages } from '../src/desktop.mjs';
import { connectIpcInspector } from '../src/ipc-inspector.mjs';
import { discoverIpc } from '../src/ipc-discover.mjs';
import { checkIpc } from '../src/ipc-check.mjs';
const require = createRequire(import.meta.url);
const exec = promisify(execFile);

test('real IPC: registration hook, serialized rejection, real retry, null and dependency boundaries, CLI cleanup', { timeout: 180000 }, async () => {
  const cdpPort = await freePort();
  let inspectorPort = await freePort();
  while (inspectorPort === cdpPort) inspectorPort = await freePort();
  const cdp = `http://127.0.0.1:${cdpPort}`;
  const inspector = `http://127.0.0.1:${inspectorPort}`;
  const app = spawn(require('electron'), ['--no-sandbox', `--inspect=127.0.0.1:${inspectorPort}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, fileURLToPath(new URL('./fixtures/ipc-electron/main.cjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  app.stderr.on('data', chunk => { errors = (errors + chunk).slice(-10000); });
  let browser; let control;
  const dir = await mkdtemp(join(tmpdir(), 'ipc-check-'));
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (app.exitCode !== null) throw new Error(errors);
      try { if ((await fetch(cdp + '/json/version')).ok && (await fetch(inspector + '/json/list')).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    browser = await connectDesktop(cdp);
    let page;
    while (Date.now() < deadline) {
      page = desktopPages(browser).find(p => p.url().includes('ipc-electron/index.html'));
      if (page) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(page, errors);
    await page.locator('#row').waitFor();
    control = await connectIpcInspector(inspector);
    assert.equal(await page.evaluate(() => typeof window.__recoveryProbeIpc), 'undefined');
    for (let i = 0; i < 16; i++) {
      assert.ok((await control.call('identify')).registered.includes('fixture:read'));
      assert.equal(await control.call('snapshot'), null);
    }
    await assert.rejects(control.call('identify', randomUUID()), /does not match/);
    const config = { cdp, inspector, channel: 'fixture:read', requiredChannels: ['fixture:versions'], readySelector: '#row', readyText: 'rp-fixture-cube.fbx', busySelector: '#spinner', retryDelayMs: 30, renderMarginMs: 500, baselineTimeoutMs: 5000 };
    const report = await checkIpc(config);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(await page.evaluate(() => Object.hasOwn(globalThis, '__recoveryProbeWindowNonce')), false);
    assert.equal(report.baseline.snapshot.channels['fixture:read'].calls, 1);
    assert.equal(report.results[0].snapshot.injected, 1);
    assert.equal(report.results[0].snapshot.successfulAfterFault, 1);
    assert.equal((await control.call('snapshot')).armed, null);
    // Simulate a protocol failure AFTER the real main-process begin has armed a
    // fault. There must be no reload/injection before the checker disarms it.
    let lostReply = false;
    let uncertainId;
    let observedReset;
    const unreliable = {
      async call(method, argument) {
        const result = await control.call(method, argument);
        if (method === 'begin' && argument.fault && !lostReply) {
          lostReply = true; uncertainId = argument.id;
          throw new Error('simulated lost begin reply');
        }
        if (method === 'reset' && argument === uncertainId) observedReset = result;
        return result;
      },
      close() {},
    };
    const uncertain = await checkIpc(config, { connectControl: async () => unreliable });
    assert.equal(lostReply, true);
    assert.equal(uncertain.ok, false);
    assert.match(uncertain.error, /lost begin reply/);
    assert.equal(uncertain.results.length, 0);
    assert.equal(observedReset.armed, null);
    assert.equal(observedReset.injected, 0);
    assert.equal(uncertain.finalReset, 'healthy');
    assert.equal((await control.call('snapshot')).armed, null);
    const nullResult = await checkIpc({ ...config, faults: ['null-result'] });
    assert.equal(nullResult.results[0].code, 'RECOVERY_NOT_OBSERVED', JSON.stringify(nullResult));
    assert.equal(nullResult.results[0].outcome, 'fail');
    assert.equal(nullResult.finalReset, 'healthy');
    const baseUrl = page.url().split('?')[0];
    await page.goto(baseUrl + '?mode=broken');
    const broken = await checkIpc(config);
    assert.equal(broken.results[0].outcome, 'fail', JSON.stringify(broken));
    assert.equal(broken.results[0].snapshot.successfulAfterFault, 0);
    await page.goto(baseUrl + '?mode=dependency-failure');
    const dependent = await checkIpc(config);
    assert.equal(dependent.baseline.code, 'DEPENDENCY_FAILED', JSON.stringify(dependent));
    assert.equal(dependent.results.length, 0);
    assert.equal(dependent.baseline.snapshot.injected, 0);
    await page.goto(baseUrl);
    await page.locator('#row').waitFor();
    const discoveryConfig = { cdp, inspector, channel: 'fixture:read', requiredChannels: ['fixture:versions'], observationMs: 600, baselineTimeoutMs: 5000, repeats: 3 };
    const discovered = await discoverIpc(discoveryConfig);
    assert.equal(discovered.error, undefined, JSON.stringify(discovered));
    assert.equal(discovered.findings[0].classification, 'RECOVERED');
    assert.equal(discovered.findings[1].classification, 'SILENT_EMPTY');
    assert.equal(discovered.findings[2].classification, 'SILENT_EMPTY');
    assert.ok(discovered.findings.every(f => f.repeatConfirmed));
    assert.equal(discovered.finalReset, 'healthy');
    assert.ok(discovered.results[0].recoveryMs >= 0);
    assert.ok(!JSON.stringify(discovered).includes('rp-fixture-cube.fbx'));
    await page.goto(baseUrl + '?mode=honest');
    const honest = await discoverIpc(discoveryConfig);
    assert.equal(honest.error, undefined, JSON.stringify(honest));
    assert.equal(honest.findings[0].classification, 'RECOVERED');
    assert.ok(honest.findings.slice(1).every(f => f.classification === 'ERROR_OR_RETRY_SHOWN'));
    assert.equal(honest.ok, true, JSON.stringify(honest));
    await page.goto(baseUrl);
    const configFile = join(dir, 'scenario.json');
    const out = join(dir, 'result');
    await writeFile(configFile, JSON.stringify(config));
    const result = await exec(process.execPath, [fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url)), 'ipc', '--config', configFile, '--out', out], { timeout: 15000 });
    assert.match(result.stdout, /PASS: rejection/);
    assert.equal(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).ok, true);
    assert.equal((await control.call('snapshot')).armed, null);
    assert.equal(app.exitCode, null);
  } finally {
    control?.close(); if (browser) await browser.close();
    if (app.exitCode === null) { const exited = new Promise(resolve => app.once('exit', resolve)); app.kill(); await exited; }
    await rm(dir, { recursive: true, force: true });
  }
});
