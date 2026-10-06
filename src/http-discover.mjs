import { matchesHealthyControl, retainPartialFindings } from './discovery-control.mjs';
import { performance } from 'node:perf_hooks';
import { pageIdentity } from './desktop.mjs';
import { readRegion, summarizeRegion, compareRegions, classifyObservation } from './ipc-observation.mjs';
import { observeHttp } from './http-observer.mjs';
import { prepareVisibility, windowVisibility } from './visibility.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function httpDiscoveryConfig(input) {
  const c = { endpoint: undefined, requiredEndpoints: [], cdp: 'http://127.0.0.1:9222', page: undefined, pageUrl: undefined, times: 2, faults: ['http-error', 'connection-failure', 'invalid-json'], baselineTimeoutMs: 15000, recoveryTimeoutMs: 8000, settleMs: 800, repeats: 3, regionSelector: undefined, restoreWindow: false };
  for (const key of Object.keys(c)) if (Object.hasOwn(input, key)) c[key] = input[key];
  const endpoint = value => { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Endpoints must be HTTP(S) origin/path without credentials, query or fragment'); return u.href; };
  c.endpoint = endpoint(c.endpoint);
  if (!Array.isArray(c.requiredEndpoints)) throw new Error('requiredEndpoints must be an array');
  c.requiredEndpoints = c.requiredEndpoints.map(endpoint);
  if (new Set([c.endpoint, ...c.requiredEndpoints]).size !== c.requiredEndpoints.length + 1) throw new Error('Use distinct endpoints');
  for (const key of ['baselineTimeoutMs', 'recoveryTimeoutMs']) if (!Number.isInteger(c[key]) || c[key] < 500 || c[key] > 30000) throw new Error(`${key} must be 500–30000`);
  if (!Number.isInteger(c.times) || c.times < 1 || c.times > 10) throw new Error('times must be 1–10');
  if (!Number.isInteger(c.settleMs) || c.settleMs < 200 || c.settleMs > 5000) throw new Error('settleMs must be 200–5000');
  if (!Number.isInteger(c.repeats) || c.repeats < 1 || c.repeats > 3) throw new Error('repeats must be 1–3');
  if (!Array.isArray(c.faults) || !c.faults.length || c.faults.some(f => !['http-error', 'connection-failure', 'invalid-json'].includes(f)) || new Set(c.faults).size !== c.faults.length) throw new Error('Invalid faults');
  if (c.regionSelector !== undefined && (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())) throw new Error('Invalid regionSelector');
  if (typeof c.restoreWindow !== 'boolean') throw new Error('restoreWindow must be boolean');
  return c;
}
export async function discoverHttp(page, input) {
  const config = httpDiscoveryConfig(input);
  const initialUrl = page.url();
  if (config.pageUrl && pageIdentity(initialUrl) !== pageIdentity(config.pageUrl)) throw new Error('Page identity mismatch');
  const report = { schemaVersion: 2, mode: 'HTTP discovery', baselines: [], results: [], findings: [], coverage: [], finalReset: 'not-verified', ok: false,
    limitation: 'Synthetic GET fetch/XHR faults on the selected origin/path; query variants share the budget. Observed structural changes are not semantic proof of a defect. Native, IPC and service-worker-only traffic are not covered. No payloads, raw UI text or credentials are saved.' };
  const coverage = new Map();
  let visibility, errors = 0, settleMs = config.settleMs;
  const onError = () => errors++;
  page.on('pageerror', onError);
  const phase = async (fault, times = 1, expectedFingerprint) => {
    const started = performance.now(), initialErrors = errors, timeline = [];
    let observer, snapshot, ui, previous, previousEvent, stableSince = started, firstInjection;
    try {
      observer = await observeHttp(page, { ...config, fault, times });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: config.baselineTimeoutMs });
      while (true) {
        snapshot = observer.snapshot();
        ui = summarizeRegion(await page.evaluate(readRegion, config.regionSelector));
        if (!ui.visible || !ui.online) { report.environment = { ...await windowVisibility(page), online: ui.online }; throw new Error('ENVIRONMENT_BLOCKED: ' + report.environment.diagnosis); }
        if (page.url() !== initialUrl) throw new Error('TARGET_NAVIGATED');
        if (snapshot.injectionError) throw new Error('INJECTION_ERROR');
        if (snapshot.injectedAt && firstInjection === undefined) firstInjection = performance.now();
        const signature = JSON.stringify(ui);
        if (signature !== previous) { stableSince = performance.now(); previous = signature; }
        const event = { elapsedMs: Math.round(performance.now() - started), ui, channels: snapshot.channels, injected: snapshot.injected };
        const eventSignature = JSON.stringify({ ...event, elapsedMs: 0 });
        if (timeline.length < 100 && eventSignature !== previousEvent) { timeline.push(event); previousEvent = eventSignature; }
        const target = snapshot.channels[config.endpoint];
        const dependencies = config.requiredEndpoints.map(e => snapshot.channels[e]);
        if (dependencies.some(r => r.errors)) throw new Error('DEPENDENCY_FAILED');
        if (target.errors) throw new Error('REAL_REQUEST_FAILED');
        const settled = target.pending === 0 && dependencies.every(r => r.successes > 0 && r.pending === 0);
        const ready = matchesHealthyControl(ui, expectedFingerprint) && settled && !ui.loading && performance.now() - stableSince >= settleMs && target.successes > 0 && (fault ? snapshot.injected === times && snapshot.successfulAfterFault > 0 && ui.fingerprint === report.baselines[0].ui.fingerprint : (ui.textLength > 0 || ui.images > 0 || ui.items > 0));
        const elapsed = performance.now() - (firstInjection ?? started);
        if (ready || elapsed >= (firstInjection === undefined ? config.baselineTimeoutMs : config.recoveryTimeoutMs)) return { fault: fault ?? 'healthy', times: fault ? times : 0, ready, elapsedMs: Math.round(performance.now() - started), ui, snapshot, timeline, newErrors: errors - initialErrors, recoveryMs: fault && ready ? Date.now() - snapshot.injectedAt : null, repeatedReads: Object.entries(snapshot.channels).filter(([, r]) => r.realCalls > 1).map(([endpoint, r]) => ({ code: 'REPEATED_READS', endpoint, count: r.realCalls, redundant: 'not-established' })) };
        await sleep(100);
      }
    } catch (error) { report.stoppedObservation ??= { reason: error.message, fault: fault ?? 'healthy', times, snapshot, ui, timeline }; throw error; }
    finally {
      if (observer) {
        for (const entry of observer.coverage()) coverage.set(entry.method + entry.endpoint, entry);
        await observer.stop();
      }
    }
  };
  try {
    visibility = await prepareVisibility(page, config); report.window = { initial: visibility.initial };
    for (let i = 0; i < 3; i++) {
      const baseline = await phase(); report.baselines.push(baseline);
      if (!baseline.ready || baseline.newErrors || baseline.ui.fingerprint !== report.baselines[0].ui.fingerprint) throw new Error('BASELINE_UNSTABLE');
    }
    const durations = report.baselines.map(b => b.elapsedMs);
    settleMs = Math.min(5000, config.settleMs + Math.max(...durations) - Math.min(...durations));
    report.readiness = { relevantEndpoints: [config.endpoint, ...config.requiredEndpoints], settleMs, note: 'Only selected dependencies gate readiness. Other/background requests are listed as untested coverage; periodicity and relevance are not inferred.' };
    for (const fault of config.faults) {
      const runs = [];
      for (let i = 0; i < config.repeats; i++) {
        const healthy = await phase(undefined, 1, report.baselines[0].ui.fingerprint);
        if (!healthy.ready || healthy.newErrors || healthy.ui.fingerprint !== report.baselines[0].ui.fingerprint) { report.failedControl = { ...healthy, reasons: { notReady: !healthy.ready, newErrors: healthy.newErrors, fingerprintChanged: healthy.ui.fingerprint !== report.baselines[0].ui.fingerprint }, diff: compareRegions(report.baselines[0].ui, healthy.ui) }; throw new Error('CONTROL_UNSTABLE'); }
        const run = await phase(fault, config.times);
        run.control = { ui: healthy.ui, snapshot: healthy.snapshot };
        run.observation = { ...compareRegions(healthy.ui, run.ui), injected: run.snapshot.injected, channels: run.snapshot.channels, recoveryMs: run.recoveryMs, repeatedReads: run.repeatedReads };
        run.interpretation = classifyObservation({ baseline: healthy.ui, final: run.ui, injected: run.snapshot.injected, expected: config.times, recovered: run.ready, newErrors: run.newErrors });
        runs.push(run); report.results.push(run);
      }
      const consistent = runs.every(r => r.interpretation.classification === runs[0].interpretation.classification);
      report.findings.push({ id: `${fault}-${config.times}`, fault, times: config.times, ...(consistent ? runs[0].interpretation : { classification: 'UNSTABLE', kind: 'inconclusive', confidence: 'low' }), confirmations: runs.length, repeatConfirmed: consistent && runs.length === 3, advice: 'Inspect this structural difference against product expectations. Rerun the saved scenario after any local fix; disappearance of a heuristic is not proof of a fix.' });
    }
  } catch (error) { report.error = error.message; }
  finally {
    try { const cleanup = await phase(undefined, 1, report.baselines[0]?.ui.fingerprint); report.cleanup = cleanup; report.finalReset = cleanup.ready && !cleanup.newErrors && cleanup.ui.fingerprint === report.baselines[0]?.ui.fingerprint ? 'healthy' : 'not-verified'; }
    catch (error) { report.cleanupError = error.message; }
    try { if (visibility) report.window.restoration = await visibility.revert(); }
    catch (error) { report.windowRestoreError = error.message; }
    page.off('pageerror', onError);
  }
  report.coverage = [...coverage.values()];
  report.ok = !report.error && !report.cleanupError && !report.windowRestoreError && report.finalReset === 'healthy' && report.findings.every(f => f.kind === 'observation');
  retainPartialFindings(report, config.repeats);
  return report;
}
