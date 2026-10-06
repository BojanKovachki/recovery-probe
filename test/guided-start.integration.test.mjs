import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runStart } from '../src/guided-start.mjs';
import { pickMarker } from '../src/pick-marker.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url));

async function clickMarker(page, selector) {
  const picked = pickMarker(page);
  await page.locator('[data-recovery-probe-picker]').waitFor();
  await page.locator(selector).click();
  return picked;
}

test('picker selects stable unique content, suppresses the click, and cleans up on cancel', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="user:name" onclick="window.clicked=true">Test User</button><p>One</p><p>Two</p>');
    const marker = await clickMarker(page, 'button');
    assert.equal(await page.locator(marker.readySelector).innerText(), 'Test User');
    assert.equal(await page.evaluate(() => window.clicked), undefined);
    assert.equal(await page.locator('[data-recovery-probe-picker]').count(), 0);
    const fallback = await clickMarker(page, 'p:last-child');
    assert.equal(await page.locator(fallback.readySelector).innerText(), 'Two');
    const cancelled = assert.rejects(pickMarker(page), /Selection cancelled/);
    await page.locator('[data-recovery-probe-picker]').waitFor();
    await page.keyboard.press('Escape');
    await cancelled;
    assert.equal(await page.locator('[data-recovery-probe-picker]').count(), 0);
  } finally { await browser.close(); }
});

test('guided authenticated portal setup, saved CLI rerun and real recovery failure', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guided-browser-'));
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.headers.cookie?.includes('session=local-fixture')) { res.end('Sign in'); return; }
    if (req.url.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end('{"name":"Test User"}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<p data-testid="profile"></p><script>
      fetch('/api/unrelated');
      async function load(){try{const r=await fetch('/api/profile?secret=omit');if(!r.ok)throw Error();const d=await r.json();document.querySelector('p').textContent=d.name}catch{${req.url === '/broken' ? '' : 'setTimeout(load,30)'}}}load();
    </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const logs = [];
  try {
    const answers = ['2', '1', '1', '1']; // endpoint, marker confirmation, automatic, one-second deadline
    const io = { interactive: true, log: value => logs.push(value), ask: async prompt => {
      if (prompt.startsWith('Sign in')) {
        const context = browser.contexts()[0];
        await context.addCookies([{ name: 'session', value: 'local-fixture', url }]);
        await context.pages()[0].goto(`${url}/working`);
        return '';
      }
      return answers.shift();
    } };
    const first = await runStart({ target: 'web', url, dir }, io, {
      launchWeb: async () => (browser = await chromium.launch()), durationMs: 200,
      pick: page => clickMarker(page, '[data-testid="profile"]'),
    });
    assert.equal(answers.length, 0);
    assert.equal(first.report.ok, true, JSON.stringify(first.report));
    assert.ok(first.report.results.every(row => row.applied === 1));
    const saved = JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8'));
    assert.equal(saved.config.endpoint, `${url}/api/profile`);
    assert.ok((await readFile(saved.config.storageState, 'utf8')).includes('local-fixture'));
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), '*\n');
    assert.ok(!(await readFile(join(first.output, 'report.json'), 'utf8')).includes('local-fixture'));
    const repeated = await exec(process.execPath, [cli, 'start', 'web', '--dir', dir, '--headless'], { timeout: 15000 });
    assert.match(repeated.stdout, /Using the saved/);
    assert.match(repeated.stdout, /PASS: invalid-json/);
    // Same assertion and auth against a broken recovery implementation must fail.
    const { writeFile } = await import('node:fs/promises');
    saved.config.pageUrl = `${url}/broken`;
    await writeFile(join(dir, 'setup.json'), JSON.stringify(saved));
    await assert.rejects(exec(process.execPath, [cli, 'start', 'web', '--dir', dir, '--headless'], { timeout: 15000 }), error => error.code === 1 && /RECOVERY_NOT_OBSERVED/.test(error.stdout));
  } finally { if (browser?.isConnected()) await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
