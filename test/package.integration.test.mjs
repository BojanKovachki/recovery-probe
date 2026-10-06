import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, access, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
// Invoke the JS entry point with Node; .bin launchers differ on Windows.
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('a clean consumer installs the packed package and verifies exports, types and CLI', { timeout: 60000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'recovery-probe-consumer-'));
  const consumer = join(temp, 'consumer');
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run this integration check with npm run test:package');
  const npm = async (args, cwd) => exec(
    process.execPath,
    [npmCli, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(temp, 'cache')],
    {
      cwd,
      timeout: 25000,
      // A parent `npm publish --dry-run` exports this setting. The nested pack
      // must still create a tarball so the consumer-install check remains real.
      env: { ...process.env, npm_config_dry_run: 'false' },
    },
  );
  try {
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', temp], root)).stdout)[0];
    assert.equal(packed.name, 'recovery-probe');
    assert.equal(packed.version, version);
    assert.ok(packed.files.some(file => file.path === 'src/fetch-fault.d.mts'));
    assert.ok(packed.files.some(file => file.path === 'CHANGELOG.md'));
    assert.ok(packed.files.every(file => !file.path.startsWith('test/') && !file.path.startsWith('artifacts/')));
    await npm(['install', join(temp, packed.filename)], consumer);
    await assert.rejects(access(join(consumer, 'node_modules', 'playwright')), error => error.code === 'ENOENT');

    const installedPackage = JSON.parse(await readFile(join(consumer, 'node_modules', 'recovery-probe', 'package.json'), 'utf8'));
    assert.equal(installedPackage.private, undefined);
    assert.deepEqual(installedPackage.engines, { node: '>=22' });

    await writeFile(join(consumer, 'check.mjs'), `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { defaultFaults, ProbeError, withFault } from 'recovery-probe';
import { createFaultFetch } from 'recovery-probe/fetch';
assert.equal(defaultFaults.length, 3);
assert.equal(ProbeError.name, 'ProbeError');
assert.equal(typeof withFault, 'function');
const desktop = await import('recovery-probe/desktop');
assert.equal(typeof desktop.checkDesktop, 'function');
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
import { createFaultFetch, type FetchFaultStats } from 'recovery-probe/fetch';
const probe = createFaultFetch(fetch, { url: 'https://example.test/data', kind: 'http-error' });
const response: Promise<Response> = probe.fetch('https://example.test/data');
const stats: FetchFaultStats = probe.assertApplied();
// @ts-expect-error Unsupported faults must be rejected by the public types.
createFaultFetch(fetch, { url: 'https://example.test/data', kind: 'not-a-fault' });
void response; void stats;
`);
    await exec(process.execPath, [tsc, '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable', 'check.mts'], { cwd: consumer, timeout: 15000 });

    await symlink(join(root, 'node_modules', 'playwright'), join(consumer, 'node_modules', 'playwright'), directoryLinkType);
    await symlink(join(root, 'node_modules', 'playwright-core'), join(consumer, 'node_modules', 'playwright-core'), directoryLinkType);
    await mkdir(join(consumer, 'node_modules', '@types'));
    await symlink(join(root, 'node_modules', '@types', 'node'), join(consumer, 'node_modules', '@types', 'node'), directoryLinkType);
    await writeFile(join(consumer, 'check-main.mts'), `
import type { Page } from 'playwright';
import { checkWeb, type WebConfig } from 'recovery-probe/web';
import { withFault, type FaultStats } from 'recovery-probe';
declare const page: Page;
const result: Promise<FaultStats> = withFault(page, {
  match: '**/api/profile',
  kind: 'http-error',
  status: 503,
}, async () => {});
// @ts-expect-error Invalid public fault kinds must fail type-checking.
void withFault(page, { match: '**/*', kind: 'not-a-fault' }, async () => {});
void result;
const webConfig: WebConfig = { pageUrl: 'http://localhost:3000', endpoint: 'http://localhost:3000/api/data', readySelector: '#data', recovery: 'automatic' };
void checkWeb(webConfig);
`);
    await exec(process.execPath, [tsc, '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable,ESNext.Disposable', '--types', 'node', 'check-main.mts'], { cwd: consumer, timeout: 15000 });

    const cli = join(consumer, 'node_modules', 'recovery-probe', 'bin', 'recovery-probe.mjs');
    const help = await exec(process.execPath, [cli, '--help'], { cwd: consumer, timeout: 10000 });
    assert.ok(help.stdout.includes('Recovery Probe ' + version));
    assert.match(help.stdout, /--config/);
    const startHelp = await exec(process.execPath, [cli, 'start', '--help'], { cwd: consumer, timeout: 10000 });
    assert.match(startHelp.stdout, /start web/);
    assert.match(startHelp.stdout, /--fresh/);
    const desktopHelp = await exec(process.execPath, [cli, 'desktop', '--help'], { cwd: consumer, timeout: 10000 });
    assert.match(desktopHelp.stdout, /--discover/);
    const webHelp = await exec(process.execPath, [cli, 'web', '--help'], { cwd: consumer, timeout: 10000 });
    assert.match(webHelp.stdout, /--login/);
    const repairHelp = await exec(process.execPath, [cli, 'repair', '--help'], { cwd: consumer, timeout: 10000 });
    assert.match(repairHelp.stdout, /--allow-source-upload/);
    const versionResult = await exec(process.execPath, [cli, '--version'], { cwd: consumer, timeout: 10000 });
    assert.equal(versionResult.stdout.trim(), version);
    // npm exec exercises the installed bin mapping, including Windows .cmd shims.
    const binVersion = await exec(process.execPath, [
      npmCli, 'exec', '--offline', '--yes=false', '--cache', join(temp, 'cache'),
      '--', 'recovery-probe', '--version',
    ], { cwd: consumer, timeout: 10000 });
    assert.equal(binVersion.stdout.trim(), version);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
