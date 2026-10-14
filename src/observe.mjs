import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { readRegion, summarizeRegion } from './ipc-observation.mjs';
import { observeHttp } from './http-observer.mjs';

export function observationConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Observation config must be an object');
  const c = { transport: undefined, cdp: 'http://127.0.0.1:9222', inspector: 'http://127.0.0.1:9229', page: undefined, pageUrl: undefined,
    channel: undefined, endpoint: undefined, regionSelector: undefined, contentSelector: undefined, observationMs: 30000, sampleMs: 100 };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(c, key)) throw Error(`Unsupported observation option: ${key}`);
    c[key] = input[key];
  }
  if (!['http', 'ipc'].includes(c.transport)) throw Error('transport must be http or ipc');
  for (const key of ['regionSelector', 'contentSelector']) if (typeof c[key] !== 'string' || !c[key].trim()) throw Error(`${key} must be an explicit CSS selector`);
  for (const [key, low, high] of [['observationMs', 500, 120000], ['sampleMs', 50, 1000]]) {
    if (!Number.isInteger(c[key]) || c[key] < low || c[key] > high) throw Error(`${key} must be ${low}–${high}`);
  }
  if (c.page !== undefined && (!Number.isInteger(c.page) || c.page < 0)) throw Error('page must be a non-negative integer');
  for (const key of ['cdp', 'inspector']) {
    const url = new URL(c[key]);
    if (!['http:', 'ws:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw Error(`${key} must be a loopback HTTP or WebSocket address without credentials`);
  }
  if (c.transport === 'http') {
    const url = new URL(c.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('endpoint must be HTTP(S) origin/path without credentials, query or fragment');
    c.endpoint = url.href;
    if (c.channel !== undefined) throw Error('channel is only supported with IPC');
  } else {
    if (typeof c.channel !== 'string' || !c.channel.trim()) throw Error('channel is required');
    if (c.endpoint !== undefined || c.page !== undefined || c.pageUrl !== undefined) throw Error('IPC selects the window owned by its development hook');
  }
  return c;
}

export function ipcObservationAdapter(control, config, senderId) {
  let id;
  return {
    async start() {
      const identity = await control.call('identify');
      if (!identity.capabilities?.observation || !identity.capabilities?.readTimestamps) throw Error('IPC_OBSERVATION_UNSUPPORTED: restart the development app with the new observation-capable hook');
      if (identity.senderId !== senderId) throw Error('IPC_TARGET_CHANGED');
      const previous = await control.call('snapshot');
      if (previous?.armed || previous?.observingUntil) throw Error('IPC_PLAN_ALREADY_ACTIVE');
      id = randomUUID(); // A lost begin reply still requires scoped cleanup.
      await control.call('begin', { id, channel: config.channel, observation: true, ttlMs: config.observationMs + 5000 });
    },
    async snapshot() {
      const s = await control.call('snapshot');
      if (!s || s.id !== id || s.senderId !== senderId || !s.observation || !s.observingUntil || s.armed || s.injected) throw Error('IPC_OBSERVATION_COVERAGE_LOST');
      return s;
    },
    async stop() {
      if (!id) return;
      // reset(id) cannot clear another client's plan, even after an uncertain reply.
      let resetError;
      try { await control.call('reset', id); } catch (error) { resetError = error; }
      const s = await control.call('snapshot');
      if (!s || s.id !== id || s.observingUntil || s.armed) throw Error(`IPC_OBSERVATION_CLEANUP_UNVERIFIED${resetError ? ': ' + resetError.message : ''}`);
    },
  };
}

export function httpObservationAdapter(page, config) {
  let observer;
  return {
    async start() { observer = await observeHttp(page, { endpoint: config.endpoint }); },
    snapshot() { return observer.snapshot(); },
    async stop() { await observer?.stop(); },
  };
}

const counts = row => ({ calls: row.calls, successes: row.successes, errors: row.errors, pending: row.pending });
const delta = (row, base) => ({ calls: row.calls - base.calls, successes: row.successes - base.successes, errors: row.errors - base.errors, pending: row.pending, pendingAtStart: base.pending });
const age = (snapshot, at) => at === null ? null : Math.max(0, snapshot.capturedAt - at);

/** Observe only. No reload, navigation, routing, focus changes or final UI reset. */
export async function runObservation(page, input, adapter, { signal, takeMarker = () => false, onReady = () => {}, onSample = () => {} } = {}) {
  const c = observationConfig(input);
  const target = c.transport === 'ipc' ? c.channel : c.endpoint;
  const report = { schemaVersion: 1, mode: 'fault-free observation', transport: c.transport, target, generatedAt: new Date().toISOString(),
    status: 'incomplete', captureComplete: false, observationMs: c.observationMs, sampleMs: c.sampleMs, intervals: [], findings: [], timeline: [],
    injected: 0, reloads: 0, cleanup: 'not-started',
    coverage: { historyBeforeCapture: 'unknown', pendingBeforeCapture: 'unknown', scope: 'One selected renderer and read target; only calls starting during capture are counted.', gaps: [] },
    limitation: 'Observations are not recovery passes or account-isolation verdicts. Cache reuse may be legitimate. Intervals start at capture or an operator marker, not at a proven mount or identity change. HTTP success means a completed 2xx response, not valid JSON or UI correctness. UI changes between samples can be missed. Only hashes, structural counts and read metadata are stored; hashes are not anonymization.' };
  let lastSnapshot, interval, started, previousSignature, samples = 0;
  let attempted = false, pageErrors = 0, newDocument = false;
  const errors = () => { pageErrors++; };
  // A document load destroys the state being investigated. SPA route changes are allowed.
  const documentLoaded = () => { newDocument = true; };
  const elapsed = () => Math.round(performance.now() - started);
  const openInterval = s => {
    const row = s.channels[target];
    interval = { index: report.intervals.length + 1, startMs: elapsed(), startCounts: counts(row), firstContent: null, samples: 0, findings: [] };
    report.intervals.push(interval);
    previousSignature = undefined;
  };
  const closeInterval = () => {
    if (!interval || !lastSnapshot) return;
    interval.endMs = elapsed();
    interval.reads = delta(lastSnapshot.channels[target], interval.startCounts);
  };
  const gap = code => { if (!report.coverage.gaps.includes(code)) report.coverage.gaps.push(code); };
  try {
    // Validate CSS without requiring the region to be mounted yet.
    await page.evaluate(({ regionSelector, contentSelector }) => { document.querySelector(regionSelector); document.querySelector(contentSelector); }, c);
    page.on('pageerror', errors); page.on('domcontentloaded', documentLoaded);
    attempted = true;
    await adapter.start();
    started = performance.now();
    lastSnapshot = await adapter.snapshot();
    report.startedAt = lastSnapshot.startedAt;
    openInterval(lastSnapshot);
    await onReady();
    while (true) {
      if (signal?.aborted) { report.status = 'interrupted'; break; }
      if (newDocument) throw Error('DOCUMENT_REPLACED: capture stopped; the in-memory state may have been reset');
      if (takeMarker()) {
        if (report.intervals.length >= 50) throw Error('INTERVAL_LIMIT_REACHED');
        // Use a fresh boundary snapshot; do not attribute between-sample reads to the next interval.
        lastSnapshot = await adapter.snapshot(); closeInterval(); openInterval(lastSnapshot);
      }
      const before = await adapter.snapshot();
      const sampleStart = elapsed();
      const raw = await page.evaluate(readRegion, { regionSelector: c.regionSelector, contentSelector: c.contentSelector });
      const ui = raw.presence === 'visible' ? summarizeRegion(raw) : raw;
      const after = await adapter.snapshot();
      if (newDocument) throw Error('DOCUMENT_REPLACED: capture stopped; the in-memory state may have been reset');
      lastSnapshot = after;
      const row = after.channels[target];
      if (!row || !Object.hasOwn(row, 'lastCompletedAt')) throw Error('READ_TIMESTAMPS_UNAVAILABLE');
      if (!ui.visible) gap('HIDDEN_DOCUMENT');
      if (ui.truncated) gap('TRUNCATED_REGION');
      const readCounts = delta(row, interval.startCounts);
      const event = { interval: interval.index, fromMs: sampleStart, toMs: elapsed(), ui,
        reads: readCounts, before: counts(before.channels[target]), after: counts(row),
        lastReadAgeMs: age(after, row.lastReadAt), lastCompletionAgeMs: age(after, row.lastCompletedAt), pageErrors };
      if (ui.visible && ui.contentCount > 0 && !interval.firstContent) {
        interval.firstContent = { fromMs: sampleStart, toMs: event.toMs, alreadyPresentAtFirstSample: interval.samples === 0,
          reads: readCounts, lastReadAgeMs: event.lastReadAgeMs, lastCompletionAgeMs: event.lastCompletionAgeMs };
      }
      if (ui.visible && ui.contentCount > 0 && readCounts.successes + readCounts.errors === 0 && !interval.findings.includes('CONTENT_BEFORE_READ')) {
        const finding = { code: 'CONTENT_BEFORE_READ', kind: 'observation', interval: interval.index, fromMs: sampleStart, toMs: event.toMs,
          basis: readCounts.calls === 0 && readCounts.pendingAtStart === 0 ? 'NO_READ_OBSERVED_IN_INTERVAL' : 'NO_COMPLETION_OBSERVED_IN_INTERVAL',
          reads: readCounts, lastReadAgeMs: event.lastReadAgeMs, lastCompletionAgeMs: event.lastCompletionAgeMs,
          note: 'The configured content marker is visible. This does not establish cache origin, ownership, a mount boundary, or a defect; earlier and unobserved reads are possible.' };
        interval.findings.push(finding.code); report.findings.push(finding);
      }
      const signature = JSON.stringify([interval.index, ui, readCounts, pageErrors]);
      if (signature !== previousSignature) {
        if (report.timeline.length < 1000) report.timeline.push(event); else gap('TIMELINE_LIMIT_REACHED');
        previousSignature = signature;
      }
      interval.samples++; samples++;
      await onSample(event);
      if (performance.now() - started >= c.observationMs) { report.status = 'complete'; break; }
      await new Promise(resolve => setTimeout(resolve, Math.min(c.sampleMs, Math.max(0, c.observationMs - (performance.now() - started)))));
    }
  } catch (error) {
    report.status = 'incomplete'; report.error = error.message;
  } finally {
    if (interval) closeInterval();
    report.elapsedMs = started === undefined ? 0 : elapsed();
    report.samples = samples;
    report.snapshot = lastSnapshot;
    page.off('pageerror', errors); page.off('domcontentloaded', documentLoaded);
    if (attempted) {
      try { await adapter.stop(); report.cleanup = 'complete'; }
      catch (error) { report.cleanup = 'unverified'; report.cleanupError = error.message; report.status = 'incomplete'; }
    }
    if (samples > 0 && !report.intervals.some(i => i.firstContent)) gap('CONTENT_MARKER_NOT_OBSERVED');
    report.captureComplete = report.status === 'complete' && report.coverage.gaps.length === 0;
  }
  return report;
}
