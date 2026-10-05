import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connectDesktop, desktopPages, selectDesktopPage, pageIdentity, discoverDesktop, checkDesktop, validateDesktopConfig } from '../src/desktop.mjs';
import { writeDesktopReport } from '../src/desktop-report.mjs';

export async function desktopMain(args) {
  if (!args.length || args.includes('--help')) {
    console.log(`Recovery Probe desktop preview

Attach to an Electron DEVELOPMENT renderer through its loopback debugging port.

  recovery-probe desktop --list [--cdp http://127.0.0.1:9222]
  recovery-probe desktop --discover --page 0 [--duration 5000] [--out .recovery-probe/discovery]
  recovery-probe desktop --config scenario.json [--out .recovery-probe/run] [--screenshots]

Discovery reloads the chosen window and lists successful renderer GET JSON endpoints.
Checks reload it once per baseline/fault, optionally click the configured Retry button,
and perform a final reload reset. The app stays open. Use a test account/environment.
The config selects one endpoint and a data-dependent readySelector; see docs/desktop.md.
Requests made by native SDKs/IPC and untouched app screens are outside this check.
Reports stay local. Screenshots are opt-in and may contain private on-screen content.`);
    return;
  }
  const options = {};
  const values = new Set(['--cdp', '--page', '--duration', '--out', '--config']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = arg.slice(2);
    if (['--list', '--discover', '--screenshots'].includes(arg)) options[key] = true;
    else if (values.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[key] = args[++i];
    } else throw new Error(`Unknown desktop option: ${arg}`);
  }
  if ([options.list, options.discover, options.config].filter(Boolean).length !== 1) throw new Error('Choose one of --list, --discover, or --config');
  if (options.page !== undefined) {
    if (!/^\d+$/.test(options.page)) throw new Error('--page must be a non-negative integer');
    options.page = Number(options.page);
  }
  if (options.duration !== undefined && (!/^\d+$/.test(options.duration) || Number(options.duration) < 200 || Number(options.duration) > 30000)) throw new Error('--duration must be 200–30000 ms');
  let config = options.config ? JSON.parse(await readFile(options.config, 'utf8')) : {};
  if (options.page !== undefined) config.page = options.page;
  config.cdp = options.cdp ?? config.cdp ?? 'http://127.0.0.1:9222';
  if (options.config) config = validateDesktopConfig(config);
  const browser = await connectDesktop(config.cdp);
  try {
    if (options.list) {
      const pages = desktopPages(browser);
      if (!pages.length) throw new Error('No renderer pages found');
      pages.forEach((page, index) => console.log(`${index}  ${pageIdentity(page.url())}`));
      return;
    }
    const page = selectDesktopPage(browser, config);
    const directory = resolve(options.out ?? `.recovery-probe/${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (options.discover) {
      const discovery = await discoverDesktop(page, { durationMs: Number(options.duration ?? 5000) });
      await writeFile(join(directory, 'discovery.json'), JSON.stringify(discovery, null, 2) + '\n', { mode: 0o600 });
      const template = { cdp: config.cdp, page: desktopPages(browser).indexOf(page), pageUrl: discovery.pageUrl, endpoint: discovery.endpoints.length === 1 ? discovery.endpoints[0].endpoint : '', readySelector: '', retrySelector: '', recovery: 'retry', timeoutMs: 5000 };
      await writeFile(join(directory, 'scenario.json'), JSON.stringify(template, null, 2) + '\n', { mode: 0o600 });
      discovery.endpoints.forEach((row, index) => console.log(`${index + 1}. GET ${row.endpoint} (${row.observed} response(s), query values omitted)`));
      if (!discovery.endpoints.length) console.log('No matching renderer GET JSON responses observed. The screen may use cached data, native SDK/IPC requests, a service worker, or load after the discovery window. This is not a pass.');
      console.log(`\nDiscovery: ${join(directory, 'discovery.json')}\nFill endpoint (if blank), readySelector and retrySelector in ${join(directory, 'scenario.json')}`);
      return;
    }
    console.log('Checking the current development renderer. It will reload between faults.');
    const report = await checkDesktop(page, config, {
      onFailure: options.screenshots ? async (target, row) => {
        const filename = `${row.kind}.png`;
        await target.screenshot({ path: join(directory, filename), timeout: 5000 });
        row.screenshot = filename;
      } : undefined,
    });
    await writeDesktopReport(directory, report, config);
    for (const row of report.results) console.log(`${row.outcome.toUpperCase().padEnd(12)} ${row.kind}: ${row.code} (injected ${row.applied}, later successful responses ${row.successfulResponsesAfterFault})`);
    console.log(`Final reload reset: ${report.finalReset}\nReport: ${join(directory, 'report.html')}\nReproduce: node ${join(directory, 'reproduce.mjs')}\nFix investigation: ${join(directory, 'fix-brief.md')}`);
    process.exitCode = report.ok ? 0 : report.results.some(row => row.outcome === 'fail') ? 1 : 2;
  } finally {
    // Closing a CDP connection disconnects this client; it does not close the existing app.
    await browser.close();
  }
}
