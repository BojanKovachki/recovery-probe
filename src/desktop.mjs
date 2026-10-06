import { defaultFaults } from './index.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const kinds = new Set(defaultFaults.map(f => f.kind));

export function pageIdentity(raw) {
  const u = new URL(raw);
  u.username = ''; u.password = ''; u.search = ''; u.hash = '';
  return u.href;
}
export function validateDesktopConfig(input) {
  const config = { times: 1, timeoutMs: 5000, recovery: 'retry', faults: [...kinds], ...input };
  for (const key of ['pageUrl', 'endpoint', 'readySelector']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`${key} is required`);
  }
  for (const key of ['baselineTimeoutMs', 'recoveryTimeoutMs']) { config[key] ??= config.timeoutMs; if (!Number.isInteger(config[key]) || config[key] < 200 || config[key] > 60000) throw new Error(`Invalid ${key}`); }
  if (!Number.isInteger(config.times) || config.times < 1 || config.times > 10) throw new Error('times must be 1–10');
  const endpoint = new URL(config.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('endpoint must be an HTTP(S) origin and path, without credentials, query, or fragment');
  }
  config.endpoint = endpoint.href;
  config.pageUrl = pageIdentity(config.pageUrl);
  if (!['retry', 'automatic'].includes(config.recovery)) throw new Error('recovery must be retry or automatic');
  if (config.recovery === 'retry' && (typeof config.retrySelector !== 'string' || !config.retrySelector.trim())) throw new Error('retrySelector is required for retry recovery');
  for (const key of ['busySelector', 'readyText']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim())) throw new Error(`${key} must be a non-empty string`);
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 200 || config.timeoutMs > 60000) throw new Error('timeoutMs must be 200–60000');
  if (!Array.isArray(config.faults) || !config.faults.length || new Set(config.faults).size !== config.faults.length || config.faults.some(f => !kinds.has(f))) throw new Error('faults must contain unique supported fault kinds');
  if (config.page !== undefined && (!Number.isInteger(config.page) || config.page < 0)) throw new Error('page must be a non-negative integer');
  return config;
}

export async function connectDesktop(cdp = 'http://127.0.0.1:9222') {
  const url = new URL(cdp);
  if (!['http:', 'ws:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('CDP must use a loopback HTTP or WebSocket address');
  }
  const { chromium } = await import('playwright');
  // Attach without overriding the application's download, focus or media settings.
  // Older Electron releases reject Playwright's default Browser.setDownloadBehavior
  // call with a browserContextId (for example Electron 29).
  return chromium.connectOverCDP(cdp, { timeout: 10000, noDefaults: true });
}
export function desktopPages(browser) {
  return browser.contexts().flatMap(context => context.pages()).filter(page => !page.url().startsWith('devtools:'));
}
export function selectDesktopPage(browser, { page: index, pageUrl } = {}) {
  const pages = desktopPages(browser);
  if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0 || !pages[index]) throw new Error('Page index not found; run desktop --list again');
    if (pageUrl && pageIdentity(pages[index].url()) !== pageIdentity(pageUrl)) throw new Error('Page identity changed; run desktop --list again');
    return pages[index];
  }
  const matches = pageUrl ? pages.filter(p => pageIdentity(p.url()) === pageIdentity(pageUrl)) : pages;
  if (matches.length !== 1) throw new Error('Select exactly one app window with --page (see desktop --list)');
  return matches[0];
}
function isReadRequest(request, page, endpoint) {
  if (request.method() !== 'GET' || !['fetch', 'xhr'].includes(request.resourceType())) return false;
  try {
    return request.frame() === page.mainFrame() && (!endpoint || pageIdentity(request.url()) === endpoint);
  } catch { return false; }
}

/** Reload the current renderer and observe metadata only. No faults are injected. */
export async function discoverDesktop(page, { durationMs = 5000, maxEndpoints = 50 } = {}) {
  if (!Number.isInteger(durationMs) || durationMs < 200 || durationMs > 30000) throw new Error('durationMs must be 200–30000');
  const found = new Map();
  const listener = response => {
    const request = response.request();
    if (!isReadRequest(request, page) || !response.ok()) return;
    const contentType = response.headers()['content-type'] ?? '';
    if (!/\bjson\b|\+json\b/i.test(contentType)) return;
    const endpoint = pageIdentity(response.url());
    if (!/^https?:/.test(endpoint)) return;
    if (found.has(endpoint)) { found.get(endpoint).observed += 1; return; }
    if (found.size >= maxEndpoints) return;
    found.set(endpoint, { endpoint, method: 'GET', observed: 1, queryValuesOmitted: Boolean(new URL(response.url()).search) });
  };
  page.on('response', listener);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(durationMs);
  } finally { page.off('response', listener); }
  return { pageUrl: pageIdentity(page.url()), endpoints: [...found.values()], limitation: 'Only successful renderer GET fetch/XHR JSON responses observed during this reload. Query variants are grouped by origin and path. Native/IPC traffic, service-worker-only traffic, and untouched routes are not covered.' };
}

async function healthy(page, config) {
  const ready = page.locator(config.readySelector);
  if (await ready.count() !== 1 || !await ready.isVisible()) return false;
  if (config.readyText !== undefined && !(await ready.innerText()).includes(config.readyText)) return false;
  if (config.busySelector) {
    const busy = page.locator(config.busySelector);
    for (const item of await busy.all()) if (await item.isVisible()) return false;
  }
  return true;
}
async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do { if (await fn()) return true; await sleep(Math.min(50, Math.max(0, deadline - Date.now()))); } while (Date.now() < deadline);
  return false;
}
async function baseline(page, config) {
  let successes = 0;
  const listener = response => { if (isReadRequest(response.request(), page, config.endpoint) && response.ok()) successes++; };
  page.on('response', listener);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: config.baselineTimeoutMs });
    return await waitUntil(async () => successes > 0 && await healthy(page, config), config.baselineTimeoutMs);
  } catch { return false; }
  finally { page.off('response', listener); }
}

/** Tests one explicitly selected GET endpoint in the existing renderer, leaving the app open. */
export async function checkDesktop(page, input, { onFailure } = {}) {
  const config = validateDesktopConfig(input);
  if (pageIdentity(page.url()) !== config.pageUrl) throw new Error('The selected page does not match pageUrl');
  // Validate locator syntax before changing page state. A typo must not be a reported app bug.
  for (const key of ['readySelector', 'retrySelector', 'busySelector']) if (config[key]) await page.locator(config[key]).count();
  // CDP can attach to a background Electron window. Activate the selected page
  // so real actionability checks receive animation frames; never force clicks.
  await page.bringToFront();
  const report = {
    schemaVersion: 1, mode: 'desktop renderer recovery', generatedAt: new Date().toISOString(),
    endpoint: config.endpoint, recovery: config.recovery, timeoutMs: config.timeoutMs, baselineTimeoutMs: config.baselineTimeoutMs, recoveryTimeoutMs: config.recoveryTimeoutMs, times: config.times,
    results: [], finalReset: 'not-run', ok: false,
    limitation: 'A pass checks only the selected GET origin/path and configured UI marker. It is not proof of overall app health. Query variants share a fault budget. Native SDK/IPC requests are outside this check.',
  };
  let stop = false;
  for (const kind of config.faults) {
    const row = { kind, outcome: 'inconclusive', code: 'BASELINE_FAILED', applied: 0, successfulResponsesAfterFault: 0, retryClicked: false };
    report.results.push(row);
    if (stop) { row.code = 'PREVIOUS_CHECK_BLOCKED'; row.outcome = 'skipped'; continue; }
    if (!await baseline(page, config)) { stop = true; continue; }
    let reserved = 0;
    let injectedAt;
    let injected = false;
    let injectionError = false;
    let stage = 'setup';
    let routeInstalled = false;
    const injectedRequests = new Set();
    const pending = new Set();
    const match = url => pageIdentity(url.href) === config.endpoint;
    const handler = async route => {
      if (reserved >= config.times || !isReadRequest(route.request(), page, config.endpoint)) return route.fallback();
      reserved++;
      injectedAt ??= Date.now();
      injectedRequests.add(route.request());
      const op = (async () => {
        try {
          if (kind === 'connection-failure') await route.abort('connectionfailed');
          else await route.fulfill({ status: kind === 'http-error' ? 503 : 200, contentType: 'application/json', body: kind === 'invalid-json' ? '{invalid-json' : '{"error":"injected-test-fault"}' });
          row.applied++;
        } catch { injectionError = true; }
        finally { injected = row.applied === config.times || injectionError; }
      })();
      pending.add(op);
      try { await op; } finally { pending.delete(op); }
    };
    // Track a successful request that started AFTER the injected request was reserved.
    // Exclude the deliberately fulfilled malformed-JSON response (HTTP 200).
    const candidates = new Set();
    const requestListener = request => {
      if (!isReadRequest(request, page, config.endpoint)) return;
      if (reserved === config.times) candidates.add(request);
    };
    const responseListener = response => {
      if (candidates.has(response.request()) && !injectedRequests.has(response.request())) {
        candidates.delete(response.request());
        if (response.ok()) row.successfulResponsesAfterFault++;
      }
    };
    const failedListener = request => candidates.delete(request);
    page.on('request', requestListener); page.on('response', responseListener); page.on('requestfailed', failedListener);
    try {
      await page.route(match, handler);
      routeInstalled = true;
      stage = 'reload';
      await page.reload({ waitUntil: 'domcontentloaded', timeout: config.baselineTimeoutMs });
      await page.bringToFront();
      if (!await waitUntil(() => injected, config.recoveryTimeoutMs)) {
        row.code = 'FAULT_NOT_TRIGGERED'; stop = true;
      } else if (injectionError) {
        row.code = 'INJECTION_ERROR'; stop = true;
      } else {
        if (config.recovery === 'retry') {
          stage = 'retry';
          const retry = page.locator(config.retrySelector);
          await retry.waitFor({ state: 'visible', timeout: config.timeoutMs });
          await retry.click({ timeout: config.timeoutMs });
          row.retryClicked = true;
        }
        stage = 'recovery';
        const remainingMs = Math.max(0, config.recoveryTimeoutMs - (Date.now() - injectedAt));
        const recovered = await waitUntil(async () => row.successfulResponsesAfterFault > 0 && await healthy(page, config), remainingMs) && Date.now() - injectedAt <= config.recoveryTimeoutMs;
        row.outcome = recovered ? 'pass' : 'fail';
        row.code = recovered ? 'RECOVERED' : 'RECOVERY_NOT_OBSERVED';
        row.recoveryMs = recovered ? Date.now() - injectedAt : null;
      }
    } catch {
      if (stage === 'setup') { row.code = 'INJECTION_ERROR'; stop = true; }
      else if (injectionError) { row.code = 'INJECTION_ERROR'; stop = true; }
      else if (row.applied !== config.times) { row.code = 'FAULT_NOT_TRIGGERED'; stop = true; }
      else if (stage === 'retry') { row.outcome = 'inconclusive'; row.code = 'RETRY_ACTION_UNAVAILABLE'; }
      else if (stage === 'recovery') { row.outcome = 'fail'; row.code = 'RECOVERY_NOT_OBSERVED'; }
      else { row.code = 'RELOAD_FAILED'; stop = true; }
    } finally {
      try { if (routeInstalled) await page.unroute(match, handler); } catch { row.outcome = 'inconclusive'; row.code = 'CLEANUP_FAILED'; stop = true; }
      await Promise.allSettled([...pending]);
      page.off('request', requestListener); page.off('response', responseListener); page.off('requestfailed', failedListener);
    }
    if (row.outcome !== 'pass' && onFailure) {
      try { await onFailure(page, row); } catch { row.evidenceCaptureFailed = true; }
    }
  }
  // A reload rescue is cleanup, not a successful Retry result.
  report.finalReset = await baseline(page, config) ? 'healthy' : 'not-verified';
  report.ok = report.results.every(row => row.outcome === 'pass') && report.finalReset === 'healthy';
  return report;
}
