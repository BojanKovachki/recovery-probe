import { writeDiscoveryReport } from '../src/discovery-report.mjs';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { discoverIpc, discoveryConfig } from '../src/ipc-discover.mjs';
import { checkIpc } from '../src/ipc-check.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function ipcMain(args) {
  if (!args.length || args.includes('--help')) {
    console.log(`Recovery Probe IPC preview
  recovery-probe ipc --config ipc-scenario.json [--out NEW_DIRECTORY] [--discover]

Requires a development-only main-process registration hook and two loopback ports:
Electron CDP (usually 9222) and Node inspector (usually 9229).
Default: verify one IPC rejection; null-result is explicitly optional.
--discover: compare healthy controls with single/double rejection and null-result experiments.
Discovery uses structural comparisons and language hints; findings require review. No readiness selector needed.
No HTTP/Rust transport faults or AI calls. See docs/ipc.md for installation and scope.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--restore-window') { options.restoreWindow = true; continue; }
    if (args[i] === '--discover') { options.discover = true; continue; }
    if (!['--config', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use ipc --config FILE [--out NEW_DIRECTORY] [--discover]');
    options[args[i].slice(2)] = args[++i];
  }
  if (!options.config) throw new Error('--config is required');
  const rawConfig = JSON.parse(await readFile(options.config, 'utf8'));
  if (options.restoreWindow) rawConfig.restoreWindow = true;
  const config = options.discover ? discoveryConfig(rawConfig) : rawConfig;
  const parent = resolve('.recovery-probe');
  let directory;
  if (options.out) { directory = resolve(options.out); await mkdir(directory, { mode: 0o700 }); }
  else { await mkdir(parent, { recursive: true, mode: 0o700 }); directory = await mkdtemp(join(parent, 'ipc-')); }
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 });
  const report = options.discover ? await discoverIpc(config) : await checkIpc(config);
  await writeFile(join(directory, 'scenario.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const html = `<!doctype html><meta charset="utf-8"><title>Recovery Probe IPC report</title><style>body{max-width:1000px;margin:40px auto;font:16px system-ui;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f7;padding:20px}</style><h1>${report.ok ? 'Selected IPC experiments completed without findings requiring review' : 'IPC recovery needs investigation'}</h1><p>${escape(report.limitation)}</p><p>Final reload: ${escape(report.finalReset)}. Cleanup cannot turn an earlier failure into a pass.</p><pre>${escape(JSON.stringify(report, null, 2))}</pre>`;
  await writeFile(join(directory, 'report.html'), html, { mode: 0o600 });
  if (options.discover) {
    await writeDiscoveryReport(directory, report, config);
    for (const finding of report.findings) console.log(`${finding.kind.toUpperCase()}: ${finding.id} — ${finding.classification}; runs=${finding.confirmations}${finding.partial ? `/${finding.plannedRuns} partial; observed=${finding.observedInterpretation.classification}` : ''}`);
    if (report.error) console.error(`Discovery stopped: ${report.error}`);
    if (report.cleanupError) console.error(`Cleanup: ${report.cleanupError}`);
    console.log(`Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}\nReplay: recovery-probe ipc --discover --config ${join(directory, 'scenario.json')}`);
    process.exitCode = report.ok ? 0 : 2; // Heuristic findings are never proven test failures.
    return;
  }
  console.log(`Baseline: ${report.baseline?.code ?? report.error ?? 'not established'}`);
  for (const row of report.results) console.log(`${row.outcome.toUpperCase()}: ${row.fault} — ${row.code}; injected=${row.snapshot.injected}; later real successes=${row.snapshot.successfulAfterFault}`);
  if (report.error) console.error(`Check stopped: ${report.error}`);
  if (report.cleanupError) console.error(`Cleanup: ${report.cleanupError}`);
  console.log(`Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}`);
  process.exitCode = report.ok ? 0 : report.results.some(row => row.outcome === 'fail') ? 1 : 2;
}
