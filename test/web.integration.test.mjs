import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkWeb, discoverWeb } from '../src/web.mjs';
const exec = promisify(execFile);

test('authenticated portal: saved login, discovery, automatic recovery, CLI/reproduction', { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-web-auth-'));
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.headers.cookie?.includes('session=fixture-login')) { res.writeHead(401); res.end('Sign in'); return; }
    if (req.url.startsWith('/api/profile')) { res.setHeader('Content-Type', 'application/json'); res.end('{"name":"Authenticated Fixture"}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<p id="profile"></p><script>async function load(){try{const r=await fetch('/api/profile?private=do-not-record');if(!r.ok)throw Error();const d=await r.json();document.querySelector('#profile').textContent=d.name}catch{setTimeout(load,30)}}load()</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = join(dir, 'auth.json');
    await writeFile(state, JSON.stringify({ cookies: [{ name: 'session', value: 'fixture-login', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
    const config = { pageUrl: `${url}/`, endpoint: `${url}/api/profile`, readySelector: '#profile', readyText: 'Authenticated Fixture', recovery: 'automatic', timeoutMs: 1000, storageState: state };
    const discovery = await discoverWeb(config, { durationMs: 200 });
    assert.equal(discovery.endpoints[0].endpoint, config.endpoint);
    assert.equal(JSON.stringify(discovery).includes('do-not-record'), false);
    assert.equal((await checkWeb(config)).ok, true);
    const unauthenticated = await checkWeb({ ...config, storageState: undefined, timeoutMs: 200 });
    assert.equal(unauthenticated.results[0].code, 'BASELINE_FAILED');
    const path = join(dir, 'scenario.json');
    await writeFile(path, JSON.stringify({ ...config, storageState: 'auth.json' }));
    const output = join(dir, 'report');
    const cli = fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url));
    const result = await exec(process.execPath, [cli, 'web', '--config', path, '--out', output], { timeout: 20000 });
    assert.match(result.stdout, /PASS/);
    assert.match(await readFile(join(output, 'report.html'), 'utf8'), /WEB PREVIEW/);
    assert.match(await readFile(join(output, 'reproduce.mjs'), 'utf8'), /checkWeb/);
    assert.ok(!(await readFile(join(output, 'report.json'), 'utf8')).includes('fixture-login'));
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
