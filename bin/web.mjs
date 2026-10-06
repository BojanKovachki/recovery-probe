import { attachMain } from './attach.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openWeb, checkWeb, discoverWeb } from '../src/web.mjs';
import { writeDesktopReport } from '../src/desktop-report.mjs';

export async function webMain(args) {
  if (args.includes('--attach') && !args.includes('--help')) return attachMain(args.filter(a => a !== '--attach'));
  if (!args.length || args.includes('--help')) {
    console.log(`Recovery Probe web preview
  recovery-probe web --attach [--discover] --config scenario.json --cdp http://127.0.0.1:9223 [--restore-window]
  recovery-probe web --login --url http://localhost:3000 --state /private/portal-state.json
  recovery-probe web --discover --url http://localhost:3000/users [--state /private/portal-state.json] [--out NEW_DIRECTORY]
  recovery-probe web --config scenario.json [--state /private/portal-state.json] [--headed] [--out NEW_DIRECTORY]

Use an authorized development/test account. Checks reload the page and inject GET faults.
Login opens a visible Chromium window. Sign in yourself, then press Enter in the terminal.
State contains credentials: never commit/share it. Automatic recovery needs no Retry UI.
Discovery writes a scenario template; fill its endpoint and data-dependent readySelector.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--login', '--discover', '--headed'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--url', '--state', '--config', '--out'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = args[++i];
    } else throw new Error(`Unknown web option: ${arg}`);
  }
  if ([options.login, options.discover, options.config].filter(Boolean).length !== 1) throw new Error('Choose --login, --discover, or --config');
  const configPath = options.config && resolve(options.config);
  const config = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : { pageUrl: options.url };
  if (config.storageState) config.storageState = resolve(dirname(configPath), config.storageState);
  if (options.state && !options.login) config.storageState = resolve(options.state);
  if (options.headed || options.login) config.headless = false;
  if (options.login) {
    if (!options.state || !process.stdin.isTTY) throw new Error('--login requires --state and an interactive terminal');
    const state = resolve(options.state);
    await mkdir(dirname(state), { recursive: true, mode: 0o700 });
    const session = await openWeb(config);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await terminal.question('Sign in using the browser, return to your app, then press Enter to save login state. ');
      const saved = await session.context.storageState({ indexedDB: true });
      await writeFile(state, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
      console.log(`Saved ${state}. Keep it private. Session-storage-only authentication needs your existing Playwright login fixture.`);
    } finally { terminal.close(); await session.browser.close(); }
    return;
  }
  const directory = resolve(options.out ?? `.recovery-probe/web-${Date.now()}`);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  if (options.discover) {
    const report = await discoverWeb(config);
    const scenario = { ...config, pageUrl: report.pageUrl, endpoint: report.endpoints.length === 1 ? report.endpoints[0].endpoint : '', readySelector: '', recovery: 'automatic', timeoutMs: 5000 };
    await writeFile(join(directory, 'discovery.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    await writeFile(join(directory, 'scenario.json'), JSON.stringify(scenario, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    console.log(`Fill in ${join(directory, 'scenario.json')}`);
    return;
  }
  const scenario = { recovery: 'automatic', ...config, target: 'web' };
  const report = await checkWeb(scenario);
  await writeDesktopReport(directory, report, scenario);
  console.log(`${report.ok ? 'PASS' : 'NOT PASSED'}: ${join(directory, 'report.html')}`);
  process.exitCode = report.ok ? 0 : report.results.some(row => row.outcome === 'fail') ? 1 : 2;
}
