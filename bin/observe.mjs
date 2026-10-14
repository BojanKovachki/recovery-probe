import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { connectDesktop, selectDesktopPage, desktopPages } from '../src/desktop.mjs';
import { connectIpcInspector } from '../src/ipc-inspector.mjs';
import { observationConfig, runObservation, httpObservationAdapter, ipcObservationAdapter } from '../src/observe.mjs';
import { observationMetadata, samplingMetrics, observationSummary, renderObservationReport } from '../src/observation-report.mjs';

export async function observeMain(args) {
  if (!args.length || args.includes('--help')) {
    console.log(`recovery-probe observe --config FILE [--out NEW_DIRECTORY] [--json] [--interactive]

Fault-free observation of an existing browser or Electron renderer.
No reload, navigation, focus change, fault injection or final UI reset.
Choose transport: http or ipc and explicit regionSelector/contentSelector CSS markers.
Sampling defaults to detail: "content"; use "region" for full DOM diagnostics.
Navigate manually during the bounded capture. Enter marks a new interval in an
interactive terminal; --interactive also enables newline markers on piped input.
Ctrl+C saves partial evidence. CONTENT_BEFORE_READ is an observation, not a defect.
IPC requires the observation-capable development hook. See docs/observe.md.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (['--json', '--interactive'].includes(args[i])) options[args[i].slice(2)] = true;
    else if (['--config', '--out'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
    else throw Error('Use observe --config FILE [--out NEW_DIRECTORY] [--json] [--interactive]');
  }
  if (!options.config) throw Error('--config is required');
  const config = observationConfig(JSON.parse(await readFile(options.config, 'utf8')));
  let directory;
  if (options.out) { directory = resolve(options.out); await mkdir(directory, { mode: 0o700 }); }
  else { const parent = resolve('.recovery-probe'); await mkdir(parent, { recursive: true, mode: 0o700 }); directory = await mkdtemp(join(parent, 'observe-')); }
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let browser, control, input, report, pendingMarkers = 0, browserVersion = null;
  try {
    browser = await connectDesktop(config.cdp);
    try { browserVersion = await browser.version(); } catch { /* Metadata may be unavailable on an attached runtime. */ }
    let page, adapter;
    if (config.transport === 'ipc') {
      control = await connectIpcInspector(config.inspector);
      const identity = await control.call('identify');
      if (!identity.registered.includes(config.channel)) throw Error('Configured read channel was not registered through the development hook');
      const pages = desktopPages(browser).filter(p => p.url() === identity.pageUrl);
      if (pages.length !== 1) throw Error('Keep exactly one matching IPC target window open');
      page = pages[0];
      const nonce = randomUUID();
      await page.evaluate(value => {
        if (Object.hasOwn(globalThis, '__recoveryProbeWindowNonce')) throw Error('Existing window challenge');
        Object.defineProperty(globalThis, '__recoveryProbeWindowNonce', { value, configurable: true });
      }, nonce);
      try { await control.call('identify', nonce); }
      finally { await page.evaluate(value => { if (globalThis.__recoveryProbeWindowNonce === value) delete globalThis.__recoveryProbeWindowNonce; }, nonce); }
      adapter = ipcObservationAdapter(control, config, identity.senderId);
    } else {
      page = selectDesktopPage(browser, config);
      adapter = httpObservationAdapter(page, config);
    }
    report = await runObservation(page, config, adapter, {
      signal: abort.signal,
      onReady() {
        if (process.stdin.isTTY || options.interactive) {
          input = createInterface({ input: process.stdin, terminal: false });
          input.on('line', () => { pendingMarkers = Math.min(50, pendingMarkers + 1); });
          input.on('SIGINT', stop);
        }
        console.error(`Observing for ${config.observationMs} ms without reloading. Navigate in the app now.${input ? ' Press Enter before each action to mark a new interval.' : ''} Ctrl+C saves partial evidence.`);
      },
      takeMarker() {
        if (!pendingMarkers) return false;
        pendingMarkers--;
        return true;
      },
      onInterval() { console.error('New observation interval.'); },
    });
  } catch (error) {
    report ??= { schemaVersion: 1, metadata: observationMetadata(), sampling: samplingMetrics(config.sampleMs).snapshot(), mode: 'fault-free observation', status: 'incomplete', captureComplete: false, intervals: [], findings: [], reloads: 0, injected: 0 };
    report.error = error.message;
  } finally {
    if (input) { input.close(); process.stdin.pause(); }
    control?.close();
    try { await browser?.close(); } catch (error) { report.status = 'incomplete'; report.captureComplete = false; report.disconnectError = error.message; }
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
  report.metadata.browserVersion = browserVersion;
  await writeFile(join(directory, 'scenario.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'report.html'), renderObservationReport(report), { mode: 0o600 });
  if (options.json) console.log(JSON.stringify({ ...report, reportPath: join(directory, 'report.json') }));
  else {
    for (const i of report.intervals) console.log(`Interval ${i.index}: ${i.reads?.calls ?? '?'} reads, ${i.reads?.successes ?? '?'} successes, ${i.reads?.errors ?? '?'} errors${i.findings.length ? '; ' + i.findings.join(', ') : ''}`);
    for (const finding of report.findings) console.log(`Interval ${finding.interval}: ${observationSummary(finding)}`);
    for (const comparison of report.comparisons ?? []) console.log(`Interval ${comparison.interval}: ${comparison.summary}`);
    console.log(`Sampling: ${config.detail}; requested delay ${config.sampleMs} ms; measured mean cadence ${report.sampling.startToStart.meanMs ?? 'unavailable'} ms.`);
    if (report.error) console.error(report.error);
    console.log(`Capture: ${report.status} (not a health verdict)\nReport: ${join(directory, 'report.html')}`);
  }
  process.exitCode = report.captureComplete ? 0 : report.status === 'interrupted' ? 130 : 2;
}
