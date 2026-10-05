import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { prepareRepair, generateRepair, verifyRepair } from '../src/repair.mjs';
import { fixture, freePort, mockProvider } from './repair-fixture.mjs';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);

test('Electron: reproduced automatic-retry failure, candidate patch, passing rebuilt app', { timeout: 90000 }, async () => {
  const f = await fixture(); const run = join(f.directory, 'run');
  try {
    await writeFile(join(f.repo, 'main.cjs'), `const {app, BrowserWindow} = require('electron');
app.setPath('userData', process.env.RECOVERY_PROBE_USER_DATA_DIR);
let window;
app.whenReady().then(async () => {
  await import('./server.mjs');
  window = new BrowserWindow({show: true, webPreferences: {contextIsolation: true, nodeIntegration: false}});
  await window.loadURL(${JSON.stringify(f.config.scenario.pageUrl)});
});
app.on('window-all-closed', () => app.quit());
`);
    await exec('git', ['add', '.'], { cwd: f.repo });
    await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-qm', 'Electron fixture'], { cwd: f.repo });
    const port = await freePort();
    f.config.target = 'desktop';
    f.config.scenario.cdp = `http://127.0.0.1:${port}`;
    f.config.scenario.timeoutMs = 1500;
    f.config.launch = [require('electron'), '--no-sandbox', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, 'main.cjs'];
    const prepared = await prepareRepair(f.config, run, { allowExecution: true });
    assert.equal(prepared.reproduced, true, JSON.stringify(prepared.before));
    await generateRepair(run, { allowSourceUpload: true, apiKey: 'mock-key', fetchImpl: mockProvider });
    const verified = await verifyRepair(run, { allowExecution: true });
    assert.equal(verified.status, 'verified-candidate', JSON.stringify(verified));
    assert.equal(await readFile(join(f.repo, 'src/app.js'), 'utf8'), f.original);
    const after = JSON.parse(await readFile(join(run, 'after.json'), 'utf8'));
    assert.ok(after.results.every(row => row.outcome === 'pass' && !row.retryClicked));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
