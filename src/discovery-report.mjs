import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function writeDiscoveryReport(directory, report, config) {
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 });
  await writeFile(join(directory, 'scenario.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const rows = report.findings.map(f => `<tr><td>${escape(f.id)}</td><td>${escape(f.classification)}</td><td>${escape(f.kind)}</td><td>${escape(f.confidence ?? 'not-rated')}</td><td>${f.partial ? `${f.completedRuns}/${f.plannedRuns} (partial)` : f.confirmations}</td><td>${escape(f.observedInterpretation?.classification ?? '')}</td></tr>`).join('');
  const summary = { error: report.error, cleanupError: report.cleanupError, finalReset: report.finalReset, window: report.window, coverage: report.coverage, readiness: report.readiness, failedControl: report.failedControl ? { reasons: report.failedControl.reasons, diff: report.failedControl.diff } : undefined };
  await writeFile(join(directory, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Recovery Probe discovery</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Recovery Probe discovery</h1><p>${escape(report.limitation)}</p><table><tr><th>Experiment</th><th>Interpretation</th><th>Kind</th><th>Confidence</th><th>Runs</th><th>Partial observation</th></tr>${rows}</table><h2>Run summary</h2><pre>${escape(JSON.stringify(summary, null, 2))}</pre><details><summary>Observations and bounded timelines</summary><pre>${escape(JSON.stringify(report, null, 2))}</pre></details>`, { mode: 0o600 });
}
