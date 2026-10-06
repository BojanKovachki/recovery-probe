import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { connectDesktop, desktopPages } from './desktop.mjs';
import { connectIpcInspector } from './ipc-inspector.mjs';
import { resetIpcAndConfirm } from './ipc-control.mjs';
import { prepareVisibility, windowVisibility } from './visibility.mjs';
import { readRegion, summarizeRegion, classifyObservation, compareRegions } from './ipc-observation.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function discoveryConfig(input) {
  const c = { cdp: 'http://127.0.0.1:9222', inspector: 'http://127.0.0.1:9229', channel: undefined, requiredChannels: [], observationMs: 8000, baselineTimeoutMs: 15000, repeats: 3, settleMs: 800, regionSelector: undefined, restoreWindow: false };
  for (const key of Object.keys(c)) if (Object.hasOwn(input, key)) c[key] = input[key];
  if (typeof c.channel !== 'string' || !c.channel.trim()) throw new Error('channel is required (an explicitly allowed read channel)');
  if (!Array.isArray(c.requiredChannels) || c.requiredChannels.some(x => typeof x !== 'string' || !x.trim() || x === c.channel) || new Set(c.requiredChannels).size !== c.requiredChannels.length) throw new Error('Invalid requiredChannels');
  for (const key of ['observationMs', 'baselineTimeoutMs']) if (!Number.isInteger(c[key]) || c[key] < 500 || c[key] > 30000) throw new Error(`${key} must be 500–30000`);
  if (!Number.isInteger(c.repeats) || c.repeats < 1 || c.repeats > 3) throw new Error('repeats must be 1–3');
  if (!Number.isInteger(c.settleMs) || c.settleMs < 200 || c.settleMs > 5000) throw new Error('settleMs must be 200–5000');
  if (c.regionSelector !== undefined && (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())) throw new Error('Invalid regionSelector');
  if (typeof c.restoreWindow !== 'boolean') throw new Error('restoreWindow must be boolean');
  return c;
}
export async function discoverIpc(input) {
  const config = discoveryConfig(input);
  const report = { schemaVersion: 2, mode: 'experimental IPC discovery', channel: config.channel, generatedAt: new Date().toISOString(), baselines: [], results: [], findings: [], finalReset: 'not-verified', ok: false,
    limitation: 'One explicitly allowed IPC read on the current screen. Synthetic renderer-boundary faults only. Structural changes and language hints produce leads, not proven product defects. No source repair, automatic navigation, HTTP/Rust coverage or uploads. UI text and repeated values are compared transiently; only hashes, structural shapes and counts are saved.' };
  const control = await connectIpcInspector(config.inspector);
  let browser, page, runId, identity, visibility;
  let settleMs = config.settleMs;
  let errorCount = 0;
  const onError = () => { errorCount++; };
  try {
    identity = await control.call('identify');
    if (!(identity.capabilities?.maxFaultCount >= 2)) throw new Error('Restart the app with the preview.6 or newer hook; repeated faults are unsupported by the loaded hook');
    for (const ch of [config.channel, ...config.requiredChannels]) if (!identity.registered.includes(ch)) throw new Error('Channel not captured: ' + ch);
    browser = await connectDesktop(config.cdp);
    const pages = desktopPages(browser).filter(p => p.url() === identity.pageUrl);
    if (pages.length !== 1) throw new Error('Keep one matching target window open');
    page = pages[0];
    const nonce = randomUUID();
    await page.evaluate(value => {
      if (Object.hasOwn(globalThis, '__recoveryProbeWindowNonce')) throw new Error('Existing window challenge');
      Object.defineProperty(globalThis, '__recoveryProbeWindowNonce', { value, configurable: true });
    }, nonce);
    try { await control.call('identify', nonce); }
    finally { await page.evaluate(value => { if (globalThis.__recoveryProbeWindowNonce === value) delete globalThis.__recoveryProbeWindowNonce; }, nonce); }
    visibility = await prepareVisibility(page, { restoreWindow: config.restoreWindow, control });
    report.window = { initial: visibility.initial };
    report.coverage = { watchedChannels: [config.channel, ...config.requiredChannels], unobservedRegisteredChannels: identity.registered.filter(c => ![config.channel, ...config.requiredChannels].includes(c)), gaps: ['Only explicitly watched channels are observed; native and other channels are unmeasured.', 'Argument-level methods within multiplexed IPC channels are not identified or separately faulted.'] };
    page.on('pageerror', onError);
    const observe = async () => {
      const summary = summarizeRegion(await page.evaluate(readRegion, config.regionSelector));
      if (!summary.visible || !summary.online) { report.environment = { ...await windowVisibility(page, control), online: summary.online, ui: summary }; throw new Error('ENVIRONMENT_BLOCKED: ' + report.environment.diagnosis); }
      if (page.url() !== identity.pageUrl) throw new Error('TARGET_NAVIGATED');
      return summary;
    };
    await observe();
    const phase = async (fault, times = 1) => {
      runId = randomUUID();
      const id = runId;
      const started = performance.now();
      const initialErrors = errorCount;
      const timeline = [];
      let stableSince = performance.now(), previous, snapshot, summary, firstInjectionObserved, previousEvent;
      try {
        await control.call('begin', { id, channel: config.channel, requiredChannels: config.requiredChannels, ...(fault ? { fault, times } : {}), ttlMs: config.baselineTimeoutMs + config.observationMs });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: config.baselineTimeoutMs });
        while (true) {
          snapshot = await control.call('snapshot');
          if (snapshot?.id !== id || snapshot.senderId !== identity.senderId) throw new Error('Probe run or target changed');
          if (snapshot.injected && firstInjectionObserved === undefined) firstInjectionObserved = performance.now();
          summary = await observe();
          const signature = JSON.stringify(summary);
          if (signature !== previous) { previous = signature; stableSince = performance.now(); }
          const target = snapshot.channels[config.channel];
          const dependencies = config.requiredChannels.map(ch => snapshot.channels[ch]);
          if (dependencies.some(row => row.errors)) throw new Error('DEPENDENCY_FAILED');
          if (target.errors) throw new Error('REAL_HANDLER_FAILED');

          const event = { elapsedMs: Math.round(performance.now() - started), injected: snapshot.injected, channels: snapshot.channels, ui: summary, uncaughtErrors: errorCount - initialErrors };
          // Bound reports without capturing payloads, filenames, error messages or stacks.
          const eventSignature = JSON.stringify({ ...event, elapsedMs: 0 });
          if (timeline.length < 100 && eventSignature !== previousEvent) { timeline.push(event); previousEvent = eventSignature; }
          const settled = target.pending === 0 && dependencies.every(row => row.successes > 0 && !row.pending);
          const stable = performance.now() - stableSince >= settleMs && !summary.loading;
          const ready = settled && stable && target.successes >= 1 && (fault ? snapshot.injected === times && snapshot.successfulAfterFault > 0 && summary.fingerprint === report.baselines[0].ui.fingerprint : (summary.textLength > 0 || summary.images > 0 || summary.items > 0));
          const elapsed = firstInjectionObserved === undefined ? performance.now() - started : performance.now() - firstInjectionObserved;
          if (ready || elapsed >= (fault && firstInjectionObserved !== undefined ? config.observationMs : config.baselineTimeoutMs)) {
            const detectedAt = Date.now();
            return { elapsedMs: Math.round(performance.now() - started), fault: fault ?? 'healthy', times: fault ? times : 0, ready, ui: summary, snapshot, timeline,
              newErrors: errorCount - initialErrors,
              recoveryDetectedAt: fault && ready ? detectedAt : null,
              recoveryMs: fault && ready ? detectedAt - snapshot.injectedAt : null,
              timingNote: `Sampled recovery with ${settleMs}ms UI stability; bounded observation starts at first observed injection.`,
              repeatedReads: Object.entries(snapshot.channels).filter(([name, row]) => row.realCalls > 1).map(([channel, row]) => ({ code: 'REPEATED_READS', channel, count: row.realCalls, redundant: 'not-established' })),
            };
          }
          await sleep(100);
        }
      } catch (error) { report.stoppedObservation ??= { reason: error.message, fault: fault ?? 'healthy', times, snapshot, ui: summary, timeline }; throw error; }
      finally { await resetIpcAndConfirm(control, id); }
    };
    try {
      for (let i = 0; i < 3; i++) {
        const baseline = await phase();
        report.baselines.push(baseline);
        if (!baseline.ready || baseline.newErrors) throw new Error('BASELINE_NOT_HEALTHY');
        if (baseline.ui.fingerprint !== report.baselines[0].ui.fingerprint) throw new Error('BASELINE_UNSTABLE: automatic text comparison is unsuitable; use explicit ipc checks');
      }
      const durations = report.baselines.map(b => b.elapsedMs);
      settleMs = Math.min(5000, config.settleMs + Math.max(...durations) - Math.min(...durations));
      report.readiness = { relevantChannels: [config.channel, ...config.requiredChannels], settleMs, note: 'Relevant channels are explicit; other/background channels do not gate readiness. Stability is not proof all unobserved data loaded.' };
      for (const experiment of [{ fault: 'rejection', times: 1 }, { fault: 'rejection', times: 2 }, { fault: 'null-result', times: 1 }]) {
        const runs = [];
        for (let i = 0; i < config.repeats; i++) {
          // A healthy control before every faulted run also clears the previous state.
          const healthy = await phase();
          if (!healthy.ready || healthy.newErrors || healthy.ui.fingerprint !== report.baselines[0].ui.fingerprint) { report.failedControl = { ...healthy, reasons: { notReady: !healthy.ready, newErrors: healthy.newErrors, fingerprintChanged: healthy.ui.fingerprint !== report.baselines[0].ui.fingerprint }, diff: compareRegions(report.baselines[0].ui, healthy.ui) }; throw new Error('CONTROL_UNSTABLE'); }
          const run = await phase(experiment.fault, experiment.times);
          run.control = { ui: healthy.ui, snapshot: healthy.snapshot };
          run.assessment = classifyObservation({ baseline: healthy.ui, final: run.ui, injected: run.snapshot.injected, expected: experiment.times, recovered: run.ready, newErrors: run.newErrors });
          run.observation = { ...compareRegions(healthy.ui, run.ui), injected: run.snapshot.injected, channels: run.snapshot.channels, recoveryMs: run.recoveryMs, repeatedReads: run.repeatedReads };
          run.interpretation = run.assessment;
          runs.push(run); report.results.push(run);
        }
        const consistent = runs.every(r => r.assessment.classification === runs[0].assessment.classification);
        const assessment = consistent ? runs[0].assessment : { classification: 'UNSTABLE', kind: 'inconclusive' };
        report.findings.push({ id: `${experiment.fault}-${experiment.times}`, ...experiment, ...assessment, confirmations: runs.length, repeatConfirmed: consistent && runs.length >= 3,
          observationMs: config.observationMs,
          advice: assessment.classification === 'SILENT_EMPTY' ? 'Inspect the error-to-empty UI branch. Preserve the distinction between a failed read and a successful empty result; consider an error message and retry action. This is a hypothesis to review locally.' : 'Review the recorded behaviour against product expectations. A finite retry limit or explicit error state is not automatically a defect.',
          verification: 'Rerun the saved scenario with ipc --discover after the local change. Compare this experiment and its healthy controls; a disappeared warning alone does not prove a fix.',
        });
      }
    } catch (error) { report.error = error.message; }
    finally {
      try {
        if (runId) await resetIpcAndConfirm(control, runId);
        const cleanup = await phase();
        report.cleanup = cleanup;
        report.finalReset = cleanup.ready && !cleanup.newErrors && cleanup.ui.fingerprint === report.baselines[0]?.ui.fingerprint ? 'healthy' : 'not-verified';
      } catch (error) { report.cleanupError = error.message; }
    }
    report.ok = !report.error && report.finalReset === 'healthy' && report.findings.every(f => f.kind === 'observation');
  } catch (error) { report.error = error.message; }
  finally {
    try { if (runId) await resetIpcAndConfirm(control, runId); }
    catch (error) { report.ok = false; report.finalReset = 'not-verified'; report.cleanupError = error.message; }
    try { if (visibility) report.window.restoration = await visibility.revert(); } catch (error) { report.ok = false; report.windowRestoreError = error.message; }
    page?.off('pageerror', onError);
    control.close(); if (browser) await browser.close();
  }
  return report;
}
