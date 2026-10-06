import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectDesktop, selectDesktopPage } from '../src/desktop.mjs';
import { discoverHttp, httpDiscoveryConfig } from '../src/http-discover.mjs';
import { writeDiscoveryReport } from '../src/discovery-report.mjs';
import { prepareVisibility } from '../src/visibility.mjs';
import { checkDesktop } from '../src/desktop.mjs';
import { writeDesktopReport } from '../src/desktop-report.mjs';
export async function attachMain(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--discover' || arg === '--restore-window') options[arg.slice(2)] = true;
    else if (['--config', '--cdp', '--out', '--page'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i];
    else throw new Error('Use web --attach [--discover] --config FILE [--cdp URL] [--page N] [--restore-window] [--out NEW_DIRECTORY]');
  }
  if (!options.config) throw new Error('--config is required');
  let config = JSON.parse(await readFile(options.config, 'utf8'));
  if (options.cdp) config.cdp = options.cdp;
  if (options.page !== undefined) { if (!/^\d+$/.test(options.page)) throw new Error('Invalid page'); config.page = Number(options.page); }
  if (options['restore-window']) config.restoreWindow = true;
  if (options.discover) config = httpDiscoveryConfig(config);
  const directory = resolve(options.out ?? `.recovery-probe/attached-${Date.now()}`);
  await mkdir(resolve(directory, '..'), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const browser = await connectDesktop(config.cdp);
  try {
    const page = selectDesktopPage(browser, config);
    let report;
    if (options.discover) { report = await discoverHttp(page, config); await writeDiscoveryReport(directory, report, config); }
    else {
      const visibility = await prepareVisibility(page, config);
      try { report = await checkDesktop(page, config); report.mode = 'attached browser recovery'; }
      finally { await visibility.revert(); }
      await writeDesktopReport(directory, report, config);
    }
    for (const f of report.findings ?? report.results) console.log(`${f.id ?? f.kind}: ${f.classification ?? f.code}${f.partial ? `; runs=${f.completedRuns}/${f.plannedRuns} partial; observed=${f.observedInterpretation.classification}` : ''}`);
    if (report.error) console.error(report.error);
    console.log(`Final reload: ${report.finalReset}\nReport: ${directory}/report.html`);
    process.exitCode = report.ok ? 0 : options.discover ? 2 : report.results.some(r => r.outcome === 'fail') ? 1 : 2;
  } finally { await browser.close(); }
}
