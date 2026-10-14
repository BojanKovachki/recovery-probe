import { createRequire } from 'node:module';
const { version } = createRequire(import.meta.url)('../package.json');

export function observationMetadata() {
  return { recoveryProbeVersion: version, runtime: { node: process.versions.node }, browserVersion: null, ipcHook: null };
}

// Aggregate every completed sample, including samples omitted from the change-only timeline.
export function samplingMetrics(requestedDelayMs) {
  let previous, count = 0, sum = 0, min = Infinity, max = 0;
  let gaps = 0, gapSum = 0, gapMin = Infinity, gapMax = 0;
  return {
    add(fromMs, toMs) {
      const duration = toMs - fromMs;
      count++; sum += duration; min = Math.min(min, duration); max = Math.max(max, duration);
      if (previous !== undefined) {
        const gap = fromMs - previous;
        gaps++; gapSum += gap; gapMin = Math.min(gapMin, gap); gapMax = Math.max(gapMax, gap);
      }
      previous = fromMs;
    },
    snapshot() {
      const stats = (n, total, low, high) => ({ count: n, meanMs: n ? Math.round(total / n * 100) / 100 : null, minMs: n ? low : null, maxMs: n ? high : null });
      return { requestedDelayMs, completedSamples: count,
        sampleDuration: stats(count, sum, min, max), startToStart: stats(gaps, gapSum, gapMin, gapMax),
        note: 'The configured delay follows each completed sample. Sample duration brackets the UI read and following counter snapshot; cadence also includes other protocol work. These are completed-sample measurements, not guaranteed temporal coverage.' };
    },
  };
}

export function observationSummary(finding) {
  if (finding.basis === 'NO_READ_OBSERVED_IN_INTERVAL') return 'Content was visible without a new selected read in this interval.';
  if (finding.basis === 'NO_COMPLETION_OBSERVED_IN_INTERVAL') return 'Content was visible before any selected read completed in this interval (a read was pending or had started).';
  return 'Content/read ordering was observed; inspect the evidence.';
}

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function renderObservationReport(report) {
  const rows = report.intervals.map(i => `<tr><td>${i.index}</td><td>${i.reads?.calls ?? 'unknown'}</td><td>${i.reads?.successes ?? 'unknown'}</td><td>${i.reads?.errors ?? 'unknown'}</td><td>${i.firstContent ? `${i.firstContent.fromMs - i.startMs}–${i.firstContent.toMs - i.startMs} ms` : 'not sampled'}</td></tr>`).join('');
  const sampling = report.sampling;
  return `<!doctype html><meta charset="utf-8"><title>Recovery Probe observation</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:20px}td,th{text-align:left;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Fault-free observation</h1><p>Capture: ${escape(report.status)}. This is not a recovery or account-isolation verdict.</p><p>Recovery Probe ${escape(report.metadata?.recoveryProbeVersion ?? 'unknown')} · Node ${escape(report.metadata?.runtime?.node ?? 'unknown')} · Browser ${escape(report.metadata?.browserVersion ?? 'unknown')} · IPC hook ${escape(report.metadata?.ipcHook?.version ?? 'unknown / not applicable')}</p>${sampling ? `<p>Configured delay: ${sampling.requestedDelayMs} ms. Completed samples: ${sampling.completedSamples}. Mean sample duration: ${sampling.sampleDuration.meanMs ?? 'unavailable'} ms. Mean start-to-start cadence: ${sampling.startToStart.meanMs ?? 'unavailable'} ms (maximum ${sampling.startToStart.maxMs ?? 'unavailable'} ms).</p><p>${escape(sampling.note)}</p>` : ''}<p>${escape(report.limitation ?? report.error)}</p><table><thead><tr><th>Interval</th><th>Reads started</th><th>Successes</th><th>Errors</th><th>First content sample bounds</th></tr></thead><tbody>${rows}</tbody></table>${report.findings.map(f => `<p>Interval ${f.interval}: ${escape(observationSummary(f))} <strong>${escape(f.code)}</strong> — ${escape(f.basis)}</p>`).join('')}<details><summary>Evidence and coverage</summary><pre>${escape(JSON.stringify(report, null, 2))}</pre></details>`;
}
