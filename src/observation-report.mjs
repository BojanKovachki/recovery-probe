import { createRequire } from 'node:module';
const { version } = createRequire(import.meta.url)('../package.json');

export function observationMetadata() {
  return { recoveryProbeVersion: version, runtime: { node: process.versions.node }, browserVersion: null, ipcHook: null };
}

// Aggregate every completed sample, including samples omitted from the change-only timeline.
export function samplingMetrics(requestedDelayMs) {
  let previous, count = 0, sum = 0, min = Infinity, max = 0;
  let gaps = 0, gapSum = 0, gapMin = Infinity, gapMax = 0;
  const phases = {};
  return {
    add(fromMs, toMs, timings = {}) {
      const duration = toMs - fromMs;
      count++; sum += duration; min = Math.min(min, duration); max = Math.max(max, duration);
      if (previous !== undefined) {
        const gap = fromMs - previous;
        gaps++; gapSum += gap; gapMin = Math.min(gapMin, gap); gapMax = Math.max(gapMax, gap);
      }
      previous = fromMs;
      for (const key of ['beforeSnapshotMs', 'uiRoundTripMs', 'rendererReadMs', 'summarizeMs', 'afterSnapshotMs']) {
        const value = timings[key];
        if (!Number.isFinite(value) || value < 0) continue;
        const p = phases[key] ??= { count: 0, sum: 0, min: Infinity, max: 0 };
        p.count++; p.sum += value; p.min = Math.min(p.min, value); p.max = Math.max(p.max, value);
      }
    },
    snapshot() {
      const round = n => Math.round(n * 100) / 100;
      const stats = (n, total, low, high) => ({ count: n, meanMs: n ? round(total / n) : null, minMs: n ? round(low) : null, maxMs: n ? round(high) : null });
      return { requestedDelayMs, completedSamples: count,
        sampleDuration: stats(count, sum, min, max), startToStart: stats(gaps, gapSum, gapMin, gapMax),
        phases: Object.fromEntries(Object.entries(phases).map(([key, p]) => [key, stats(p.count, p.sum, p.min, p.max)])),
        note: 'The configured delay follows each completed sample. Sample duration brackets the UI read and following counter snapshot; cadence also includes other protocol work. These are completed-sample measurements, not guaranteed temporal coverage.' };
    },
  };
}

// Compare samples only; these summaries cannot establish ownership or freshness.
const contentEvidence = e => ({ interval: e.interval, fromMs: e.fromMs, toMs: e.toMs,
  presence: e.ui.presence, visible: e.ui.visible, content: e.ui.content ?? null });
function compareContent(before, after) {
  const a = before.content, b = after.content;
  const comparable = before.visible && after.visible && a && b && !a.truncated && !b.truncated;
  return !comparable ? 'unavailable' : a.count === b.count && a.textFingerprint === b.textFingerprint ? 'unchanged' : 'changed';
}

export function contentComparison(basis, before, after) {
  const result = compareContent(contentEvidence(before), contentEvidence(after));
  return { kind: 'observation', basis, interval: after.interval, result, before: contentEvidence(before), after: contentEvidence(after),
    ...(basis === 'READ_COMPLETION' ? { completions: { successes: after.before.successes - before.after.successes,
      errors: after.before.errors - before.after.errors } } : { reads: after.reads }),
    summary: `${basis === 'READ_COMPLETION' ? 'Across observed read completion(s)' : 'On the first sampled content in this interval'}, selected marker text/count comparison: ${result}.`,
    note: 'Ordered normalized visible marker text/count only. Other values, ownership, freshness and changes between samples are unknown. Completion does not imply renderer consumption.' };
}

export function comparisonFollowUpSummary(comparison) {
  const f = comparison.followUp;
  if (!f) return ''; // Reports from older versions have no follow-up evidence.
  if (!f.samples) return 'No later sample in this interval.';
  const matched = f.firstBaselineMatch;
  const prefix = comparison.result === 'changed' && matched
    ? `Initially different; a later sample matched the baseline (${matched.fromMs}–${matched.toMs} ms from capture start). ` : '';
  return `${prefix}Latest follow-up sample (${f.latest.fromMs}–${f.latest.toMs} ms from capture start): ${f.latest.result} against the baseline. ${f.comparableSamples} comparable, ${f.unavailableSamples} unavailable later samples. These samples do not establish continuous visibility or stability.`;
}

export function contentComparisons() {
  let interval, anchor, lastContent, returnBaseline, comparedReturn = false;
  let active = [], retained = 0;
  const completed = counts => counts.successes + counts.errors;
  return {
    add(event) {
      const results = [];
      if (interval !== event.interval) {
        interval = event.interval; anchor = undefined; returnBaseline = lastContent; comparedReturn = false;
        active = []; // Later intervals cannot resolve an earlier comparison.
      }
      for (const comparison of active) {
        const f = comparison.followUp;
        const evidence = contentEvidence(event);
        const result = compareContent(comparison.before, evidence);
        f.samples++;
        if (result === 'unavailable') f.unavailableSamples++; else f.comparableSamples++;
        f.latest = { ...evidence, result };
        if (result === 'unchanged' && !f.firstBaselineMatch) f.firstBaselineMatch = evidence;
        f.summary = comparisonFollowUpSummary(comparison);
      }
      if (event.ui.visible && event.ui.contentCount > 0) {
        if (returnBaseline && !comparedReturn) results.push(contentComparison('INTERVAL_RETURN', returnBaseline, event));
        comparedReturn = true; lastContent = event;
      }
      if (anchor && completed(event.after) > completed(anchor.after)) {
        // A completion during the UI read is ambiguous. Retain the earlier
        // sample until a later UI read is bracketed by settled counters.
        if (completed(event.before) === completed(event.after)) {
          results.push(contentComparison('READ_COMPLETION', anchor, event));
          anchor = event;
        }
      } else anchor = event;
      for (const comparison of results) {
        // Match the report's global comparison cap; do not retain discarded evidence.
        if (retained >= 1000) break;
        comparison.followUp = { samples: 0, comparableSamples: 0, unavailableSamples: 0,
          firstBaselineMatch: null, latest: null, summary: 'No later sample in this interval.' };
        retained++; active.push(comparison);
      }
      return results;
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
  const comparisons = (report.comparisons ?? []).map(c => `<p>Interval ${escape(c.interval)}: ${escape(c.summary)} ${c.completions ? `(${c.completions.successes} successful, ${c.completions.errors} failed read completions)` : `(${c.reads.calls} selected reads started in this interval)`} ${escape(comparisonFollowUpSummary(c))}</p>`).join('');
  const phases = Object.entries(sampling?.phases ?? {}).map(([name, s]) => `<tr><td>${escape(name)}</td><td>${s.meanMs}</td><td>${s.maxMs}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Recovery Probe observation</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:20px}td,th{text-align:left;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Fault-free observation</h1><p>Capture: ${escape(report.status)}. This is not a recovery or account-isolation verdict.</p><p>Recovery Probe ${escape(report.metadata?.recoveryProbeVersion ?? 'unknown')} · Node ${escape(report.metadata?.runtime?.node ?? 'unknown')} · Browser ${escape(report.metadata?.browserVersion ?? 'unknown')} · IPC hook ${escape(report.metadata?.ipcHook?.version ?? 'unknown / not applicable')}</p>${sampling ? `<p>Configured delay: ${sampling.requestedDelayMs} ms. Completed samples: ${sampling.completedSamples}. Mean sample duration: ${sampling.sampleDuration.meanMs ?? 'unavailable'} ms. Mean start-to-start cadence: ${sampling.startToStart.meanMs ?? 'unavailable'} ms (maximum ${sampling.startToStart.maxMs ?? 'unavailable'} ms).</p><p>${escape(sampling.note)}</p>` : ''}<p>Sampling detail: ${escape(report.detail ?? 'region (legacy)')}. Marker counts describe the configured content selector; generic region item counts are heuristics.</p>${phases ? `<table><thead><tr><th>Measured phase</th><th>Mean ms</th><th>Maximum ms</th></tr></thead><tbody>${phases}</tbody></table><p>Renderer read time is included in the UI round trip, not additional to it.</p>` : ''}<p>${escape(report.limitation ?? report.error)}</p><table><thead><tr><th>Interval</th><th>Reads started</th><th>Successes</th><th>Errors</th><th>First content sample bounds</th></tr></thead><tbody>${rows}</tbody></table>${report.findings.map(f => `<p>Interval ${f.interval}: ${escape(observationSummary(f))} <strong>${escape(f.code)}</strong> — ${escape(f.basis)}</p>`).join('')}${comparisons}<p>Comparisons concern sampled marker text and count, not ownership or freshness. A completion does not guarantee the UI has consumed its result.</p><p>Cleanup: ${escape(report.cleanup ?? 'unknown')}. The observation snapshot is from before cleanup; cleanupEvidence records the separate cleanup check when available.</p><details><summary>Evidence and coverage</summary><pre>${escape(JSON.stringify(report, null, 2))}</pre></details>`;
}
