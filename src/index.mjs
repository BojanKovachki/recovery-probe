export { createFaultFetch } from './fetch-fault.mjs';

const modes = new Set(['http-error', 'connection-failure', 'invalid-json']);

export const defaultFaults = Object.freeze([
  Object.freeze({ name: 'HTTP 503 once', kind: 'http-error', status: 503 }),
  Object.freeze({ name: 'Interrupted request once', kind: 'connection-failure' }),
  Object.freeze({ name: 'Malformed JSON once', kind: 'invalid-json' }),
]);

export class ProbeError extends Error {
  constructor(code, message, stats, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProbeError';
    this.code = code;
    this.stats = stats;
  }
}

function checkFault(options) {
  if (!options || !(typeof options.match === 'string' && options.match.trim() || options.match instanceof RegExp)) {
    throw new TypeError('match must be a non-empty Playwright URL glob or RegExp');
  }
  if (!modes.has(options.kind)) throw new TypeError('Unsupported fault kind');
  const count = options.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new TypeError('count must be an integer from 1 to 20');
  const status = options.status ?? 503;
  if (options.kind === 'http-error' && (!Number.isInteger(status) || status < 400 || status > 599)) {
    throw new TypeError('HTTP fault status must be from 400 to 599');
  }
  const method = options.method ?? 'GET';
  if (!/^[A-Z]+$/.test(method)) throw new TypeError('method must be an uppercase HTTP method');
  return { count, status, method };
}

/** Inject a bounded fault for one explicitly matched endpoint, then restore routing. */
export async function withFault(page, options, exercise) {
  const { count, status, method } = checkFault(options);
  if (typeof exercise !== 'function') throw new TypeError('exercise must be a function');
  let reserved = 0;
  let applied = 0;
  let injectionErrors = 0;
  const pending = new Set();
  const stats = () => ({ kind: options.kind, requested: count, applied, injectionErrors });

  const handler = async (route) => {
    if (route.request().method() !== method || reserved >= count) {
      await route.fallback();
      return;
    }
    // Reserve synchronously: concurrent matching requests cannot exceed the count.
    reserved += 1;
    const operation = (async () => {
      try {
        if (options.kind === 'connection-failure') {
          await route.abort('connectionfailed');
        } else if (options.kind === 'http-error') {
          await route.fulfill({ status, contentType: 'application/json', body: '{"error":"injected-test-fault"}' });
        } else {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid-json' });
        }
        applied += 1;
      } catch {
        injectionErrors += 1;
        // Error details can contain URLs or credentials. Keep the report structural.
      }
    })();
    pending.add(operation);
    try { await operation; } finally { pending.delete(operation); }
  };

  await page.route(options.match, handler);
  let exerciseError;
  let exerciseFailed = false;
  let cleanupError;
  try {
    await exercise();
  } catch (error) {
    exerciseFailed = true;
    exerciseError = error;
  } finally {
    try {
      // Remove only our handler; existing user mocks remain registered.
      await page.unroute(options.match, handler);
    } catch (error) { cleanupError = error; }
    await Promise.allSettled([...pending]);
  }

  if (cleanupError || injectionErrors) {
    throw new ProbeError('INJECTION_ERROR', 'The fault could not be applied or cleaned up reliably.', stats(), cleanupError);
  }
  if (applied !== count) {
    throw new ProbeError('FAULT_NOT_TRIGGERED', `Expected ${count} injected request(s), observed ${applied}. Check the endpoint, method, cache and service workers.`, stats(), exerciseError);
  }
  if (exerciseFailed) {
    throw new ProbeError('RECOVERY_ASSERTION_FAILED', 'The configured recovery expectation did not pass.', stats(), exerciseError);
  }
  return stats();
}

function checkScenario(config) {
  for (const name of ['url', 'requestPattern', 'readySelector', 'retrySelector']) {
    if (typeof config?.[name] !== 'string' || !config[name].trim()) throw new TypeError(`${name} is required`);
  }
  const parsed = new URL(config.url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('url must use HTTP or HTTPS');
  if (parsed.username || parsed.password) throw new TypeError('Credentials in the URL are unsupported');
  const timeoutMs = config.timeoutMs ?? 3000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new TypeError('timeoutMs must be 100–60000');
  return timeoutMs;
}

/** Check a read-only page that automatically loads data and exposes a Retry button. */
export async function probeRecovery(browser, config) {
  const timeoutMs = checkScenario(config);
  const results = [];
  async function inPage(fn) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);
      return await fn(page);
    } finally { await context.close(); }
  }

  let baselineError;
  try {
    await inPage(async page => {
      await page.goto(config.url, { waitUntil: 'domcontentloaded' });
      await page.locator(config.readySelector).waitFor({ state: 'visible' });
    });
  } catch (error) { baselineError = error; }
  results.push({ scenario: 'Normal connection', outcome: baselineError ? 'inconclusive' : 'pass', code: baselineError ? 'BASELINE_FAILED' : 'OK', applied: 0 });

  if (baselineError) {
    for (const fault of defaultFaults) results.push({ scenario: fault.name, outcome: 'skipped', code: 'BASELINE_FAILED', applied: 0 });
  } else {
    for (const fault of defaultFaults) {
      try {
        const stats = await inPage(page => withFault(page, { ...fault, match: config.requestPattern }, async () => {
          await page.goto(config.url, { waitUntil: 'domcontentloaded' });
          await page.locator(config.retrySelector).waitFor({ state: 'visible' });
          await page.locator(config.retrySelector).click();
          await page.locator(config.readySelector).waitFor({ state: 'visible' });
        }));
        results.push({ scenario: fault.name, outcome: 'pass', code: 'OK', applied: stats.applied });
      } catch (error) {
        results.push({
          scenario: fault.name,
          outcome: error.code === 'RECOVERY_ASSERTION_FAILED' ? 'fail' : 'inconclusive',
          code: error.code ?? 'RUNNER_ERROR',
          applied: error.stats?.applied ?? 0,
        });
      }
    }
  }
  return { name: config.name ?? 'Recovery check', ok: results.every(row => row.outcome === 'pass'), results };
}
