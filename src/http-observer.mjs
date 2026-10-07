import { performance } from 'node:perf_hooks';
import { pageIdentity } from './desktop.mjs';
export async function observeHttp(page, { endpoint, requiredEndpoints = [], fault, times = 1 }) {
  const channels = Object.fromEntries([endpoint, ...requiredEndpoints].map(e => [e, { calls: 0, realCalls: 0, successes: 0, errors: 0, pending: 0, maxDurationMs: 0 }]));
  const requests = new Map(), coverage = new Map(), operations = new Set();
  let reserved = 0, applied = 0, injectedAt = null, successfulAfterFault = 0, active = true, injectionError = false;
  let routed = Boolean(fault);
  const mainRead = r => { try { return r.frame() === page.mainFrame() && ['fetch', 'xhr'].includes(r.resourceType()); } catch { return false; } };
  const request = r => {
    if (!mainRead(r)) return;
    const url = pageIdentity(r.url());
    if (coverage.size < 100) coverage.set(`${r.method()} ${url}`, { method: r.method(), endpoint: url, supported: r.method() === 'GET', tested: r.method() === 'GET' && url === endpoint, reason: r.method() !== 'GET' ? 'Non-GET injection is unsupported' : url !== endpoint ? 'Observed, not selected for injection' : undefined });
    const row = r.method() === 'GET' && channels[url];
    if (!row) return;
    row.calls++; row.realCalls++; row.pending++;
    requests.set(r, { row, start: performance.now(), injected: false, afterFault: reserved === times && injectedAt !== null, target: url === endpoint });
  };
  const finish = async (r, failed) => {
    const meta = requests.get(r); if (!meta) return;
    requests.delete(r);
    const response = failed ? null : await r.response().catch(() => null);
    meta.row.pending--;
    if (meta.injected) return;
    meta.row.maxDurationMs = Math.max(meta.row.maxDurationMs, Math.round(performance.now() - meta.start));
    if (response?.ok()) { meta.row.successes++; if (meta.target && meta.afterFault) successfulAfterFault++; }
    else meta.row.errors++;
  };
  const finished = r => { const p = finish(r, false); operations.add(p); p.finally(() => operations.delete(p)); };
  const failed = r => { const p = finish(r, true); operations.add(p); p.finally(() => operations.delete(p)); };
  const match = url => pageIdentity(url.href) === endpoint;
  const handler = async route => {
    const r = route.request();
    if (!active || reserved >= times || !mainRead(r) || r.method() !== 'GET') return route.fallback();
    reserved++; injectedAt ??= Date.now();
    const meta = requests.get(r);
    if (meta) { meta.injected = true; meta.row.realCalls--; }
    const op = (async () => {
      try {
        if (fault === 'connection-failure') await route.abort('connectionfailed');
        else await route.fulfill({ status: fault === 'http-error' ? 503 : 200, contentType: 'application/json', body: fault === 'invalid-json' ? '{invalid-json' : '{"error":"injected-test-fault"}' });
        applied++;
      } catch { injectionError = true; }
    })();
    operations.add(op); try { await op; } finally { operations.delete(op); }
  };
  page.on('request', request); page.on('requestfinished', finished); page.on('requestfailed', failed);
  try { if (fault) await page.route(match, handler); }
  catch (error) { page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed); throw error; }
  return {
    snapshot: () => ({ injected: applied, injectedAt, successfulAfterFault, injectionError, armed: fault && active && reserved < times ? { remaining: times - reserved } : null, channels: structuredClone(channels) }),
    coverage: () => [...coverage.values()],
    async disarm() {
      active = false;
      if (routed) { await page.unroute(match, handler); routed = false; }
      await Promise.allSettled([...operations]);
    },
    async stop() {
      active = false;
      try { if (routed) { await page.unroute(match, handler); routed = false; } await Promise.allSettled([...operations]); }
      finally { page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed); }
    },
  };
}
