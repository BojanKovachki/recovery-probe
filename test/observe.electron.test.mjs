import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './repair-fixture.mjs';
import { connectDesktop, desktopPages } from '../src/desktop.mjs';
import { connectIpcInspector } from '../src/ipc-inspector.mjs';
const require = createRequire(import.meta.url);

test('real Electron observation CLI preserves cache across identity changes and leaves no active observer', { timeout: 45000 }, async () => {
  const cdpPort = await freePort(); let inspectorPort = await freePort();
  while (inspectorPort === cdpPort) inspectorPort = await freePort();
  const cdp = `http://127.0.0.1:${cdpPort}`, inspector = `http://127.0.0.1:${inspectorPort}`;
  const app = spawn(require('electron'), ['--no-sandbox', `--inspect=127.0.0.1:${inspectorPort}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, fileURLToPath(new URL('./fixtures/cache-electron/main.cjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; app.stderr.on('data', b => { stderr = (stderr + b).slice(-5000); });
  let browser, control, cli;
  const dir = await mkdtemp(join(tmpdir(), 'observe-electron-'));
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (app.exitCode !== null) throw Error(stderr);
      try { if ((await fetch(cdp + '/json/version')).ok && (await fetch(inspector + '/json/list')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await connectDesktop(cdp);
    let page;
    while (Date.now() < deadline) {
      page = desktopPages(browser).find(p => p.url().includes('/cache.html'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, stderr);
    control = await connectIpcInspector(inspector);
    const base = page.url();
    const config = { transport: 'ipc', cdp, inspector, channel: 'fixture:cache-read', regionSelector: '#records-region', contentSelector: 'li', sampleMs: 50, observationMs: 1500 };
    const configPath = join(dir, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    for (const fixed of [false, true]) {
      if (fixed) await page.goto(base + '?fixed=true');
      await page.click('#items'); await page.locator('#records li').waitFor();
      await page.click('#home'); await page.click('#switch');
      const nonce = await page.evaluate(() => window.fixtureNonce);
      const out = join(dir, fixed ? 'fixed' : 'broken');
      cli = spawn(process.execPath, [fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url)), 'observe', '--config', configPath, '--out', out, '--json', '--interactive'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '';
      cli.stdout.on('data', b => { output += b; });
      const exit = once(cli, 'exit');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('CLI did not start: ' + errors)), 15000);
        cli.once('exit', code => { clearTimeout(timer); if (code) reject(Error(errors || 'CLI exited early')); });
        cli.stderr.on('data', b => { errors += b; if (errors.includes('Observing for')) { clearTimeout(timer); resolve(); } });
      });
      assert.equal((await control.call('snapshot')).armed, null);
      cli.stdin.write('\n');
      const markerDeadline = Date.now() + 1000;
      while (!errors.includes('New observation interval.') && Date.now() < markerDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.match(errors, /New observation interval/);
      await page.click('#items');
      const [code] = await exit; cli = undefined;
      assert.equal(code, 0, errors + output);
      const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
      assert.equal(report.captureComplete, true, JSON.stringify(report));
      assert.equal(report.metadata.recoveryProbeVersion, createRequire(import.meta.url)('../package.json').version);
      assert.equal(report.metadata.ipcHook.version, report.metadata.recoveryProbeVersion);
      assert.ok(report.metadata.ipcHook.runtime.electron);
      assert.ok(report.metadata.browserVersion);
      assert.equal(report.sampling.completedSamples, report.samples);
      assert.equal(report.sampling.startToStart.count, report.samples - 1);
      assert.equal(report.snapshot.channels[config.channel].calls, fixed ? 1 : 0);
      assert.equal(report.findings.length, fixed ? 0 : 1);
      assert.equal(report.intervals.length, 2);
      assert.equal(report.intervals[1].reads.calls, fixed ? 1 : 0);
      if (!fixed) assert.equal(report.findings[0].interval, 2);
      assert.equal(await page.evaluate(() => window.fixtureNonce), nonce);
      assert.equal((await control.call('snapshot')).observingUntil, null);
      assert.equal((await control.call('snapshot')).armed, null);
      assert.equal(await page.evaluate(() => Object.hasOwn(globalThis, '__recoveryProbeWindowNonce')), false);
      assert.ok(!JSON.stringify(report).includes('private-value'));
      assert.equal(JSON.parse(output).status, 'complete');
      assert.equal(app.exitCode, null);
    }
  } finally {
    cli?.kill(); control?.close(); await browser?.close();
    if (app.exitCode === null) { const exit = once(app, 'exit'); app.kill(); await exit; }
    await rm(dir, { recursive: true, force: true });
  }
});
