import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('a clean consumer installs the packed core offline, executes it and type-checks without Playwright', { timeout: 60000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'recovery-probe-consumer-'));
  const consumer = join(temp, 'consumer');
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run this integration check with npm run test:package');
  const npm = async (args, cwd) => exec(process.execPath, [npmCli, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(temp, 'cache')], { cwd, timeout: 25000 });
  try {
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', temp], root)).stdout)[0];
    assert.ok(packed.files.some(file => file.path === 'src/fetch-fault.d.mts'));
    assert.ok(packed.files.every(file => !file.path.startsWith('test/') && !file.path.startsWith('artifacts/') && file.path !== 'BUSINESS.md'));
    await npm(['install', join(temp, packed.filename)], consumer);
    await assert.rejects(access(join(consumer, 'node_modules', 'playwright')), error => error.code === 'ENOENT');

    await writeFile(join(consumer, 'check.mjs'), `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFaultFetch } from 'recovery-probe-prototype/fetch';
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ result: 'consumer received real data' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = 'http://127.0.0.1:' + server.address().port + '/data';
  const probe = createFaultFetch(fetch, { url, kind: 'http-error' });
  assert.equal((await probe.fetch(url)).status, 503);
  assert.deepEqual(await (await probe.fetch(url)).json(), { result: 'consumer received real data' });
  probe.assertApplied();
  console.log('INSTALLED_CONSUMER_OK');
} finally {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
`);
    const result = await exec(process.execPath, ['check.mjs'], { cwd: consumer, timeout: 10000 });
    assert.match(result.stdout, /INSTALLED_CONSUMER_OK/);

    await writeFile(join(consumer, 'check.mts'), `
import { createFaultFetch, type FetchFaultStats } from 'recovery-probe-prototype/fetch';
const probe = createFaultFetch(fetch, { url: 'https://example.test/data', kind: 'http-error' });
const response: Promise<Response> = probe.fetch('https://example.test/data');
const stats: FetchFaultStats = probe.assertApplied();
// @ts-expect-error Unsupported faults must be rejected by the public types.
createFaultFetch(fetch, { url: 'https://example.test/data', kind: 'not-a-fault' });
void response; void stats;
`);
    await exec(join(root, 'node_modules', '.bin', 'tsc'), ['--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable', 'check.mts'], { cwd: consumer, timeout: 15000 });
    const help = await exec(process.execPath, [join(consumer, 'node_modules', 'recovery-probe-prototype', 'bin', 'recovery-probe.mjs'), '--help'], { cwd: consumer, timeout: 10000 });
    assert.match(help.stdout, /Recovery Probe/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
