import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { checkIpc } from '../src/ipc-check.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function ipcMain(args) {
  if (!args.length || args.includes('--help')) {
    console.log(`Recovery Probe IPC preview
  recovery-probe ipc --config ipc-scenario.json [--out NEW_DIRECTORY]

Requires a development-only main-process registration hook and two loopback ports:
Electron CDP (usually 9222) and Node inspector (usually 9229).
Checks renderer recovery after one IPC rejection; null-result is explicitly optional.
No HTTP/Rust transport faults or AI calls. See docs/ipc.md for installation and scope.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--config', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use ipc --config FILE [--out NEW_DIRECTORY]');
    options[args[i].slice(2)] = args[++i];
  }
  if (!options.config) throw new Error('--config is required');
  const config = JSON.parse(await readFile(options.config, 'utf8'));
  const parent = resolve('.recovery-probe');
  let directory;
  if (options.out) { directory = resolve(options.out); await mkdir(directory, { mode: 0o700 }); }
  else { await mkdir(parent, { recursive: true, mode: 0o700 }); directory = await mkdtemp(join(parent, 'ipc-')); }
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 });
  const report = await checkIpc(config);
  await writeFile(join(directory, 'scenario.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const html = `<!doctype html><meta charset="utf-8"><title>Recovery Probe IPC report</title><style>body{max-width:1000px;margin:40px auto;font:16px system-ui;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f7;padding:20px}</style><h1>${report.ok ? 'Selected IPC recovery checks passed' : 'IPC recovery needs investigation'}</h1><p>${escape(report.limitation)}</p><p>Final reload: ${escape(report.finalReset)}. Cleanup cannot turn an earlier failure into a pass.</p><pre>${escape(JSON.stringify(report, null, 2))}</pre>`;
  await writeFile(join(directory, 'report.html'), html, { mode: 0o600 });
  console.log(`Baseline: ${report.baseline?.code ?? report.error ?? 'not established'}`);
  for (const row of report.results) console.log(`${row.outcome.toUpperCase()}: ${row.fault} — ${row.code}; injected=${row.snapshot.injected}; later real successes=${row.snapshot.successfulAfterFault}`);
  console.log(`Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}`);
  process.exitCode = report.ok ? 0 : report.results.some(row => row.outcome === 'fail') ? 1 : 2;
}
