import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-repair-test-'));
  const repo = join(directory, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  const port = await freePort();
  await writeFile(join(repo, 'package.json'), '{"type":"module"}');
  await writeFile(join(repo, 'src', 'app.js'), `let busy = false;
async function load() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch('/api/profile');
    if (!response.ok) throw new Error('Request failed');
    const data = await response.json();
    document.querySelector('#profile').textContent = data.name;
    busy = false;
  } catch {
    // BUG: the loading flag prevents the scheduled retry.
    setTimeout(load, 30);
  }
}
load();
`);
  await writeFile(join(repo, 'server.mjs'), `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/api/profile') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({name:'Repair Fixture'})); }
  else if (req.url === '/app.js') { res.setHeader('Content-Type','text/javascript'); res.end(await readFile(new URL('./src/app.js', import.meta.url))); }
  else { res.setHeader('Content-Type','text/html'); res.end('<p id="profile"></p><script type="module" src="/app.js"></script>'); }
});
server.listen(${port}, '127.0.0.1');
`);
  await writeFile(join(repo, 'regression.mjs'), `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile('src/app.js', 'utf8');
// A deliberately modest existing regression: preserve the real fetch and data display.
assert.ok(source.includes("fetch('/api/profile')"));
assert.ok(source.includes('textContent = data.name'));
`);
  await exec('git', ['init', '-q', repo]);
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['-c', 'user.name=Recovery Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Broken automatic retry fixture'], { cwd: repo });
  const config = { target: 'web', repo, sourceFiles: ['src/app.js'], launch: [process.execPath, 'server.mjs'], tests: [[process.execPath, 'regression.mjs']], provider: { model: 'mock-provider-not-a-real-model' }, scenario: { pageUrl: `http://127.0.0.1:${port}/`, endpoint: `http://127.0.0.1:${port}/api/profile`, readySelector: '#profile', readyText: 'Repair Fixture', recovery: 'automatic', timeoutMs: 1000 } };
  return { directory, repo, config, original: await readFile(join(repo, 'src/app.js'), 'utf8') };
}
export const fixtureProposal = { summary: 'Reset the loading guard before retry', reasoning: 'The failed request leaves busy true so the scheduled load exits before fetching. Reset it in the catch before scheduling the existing retry.', edits: [{ path: 'src/app.js', find: '// BUG: the loading flag prevents the scheduled retry.', replace: 'busy = false;' }] };
export const mockProvider = async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(fixtureProposal) }] }] }) });
