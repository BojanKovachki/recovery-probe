const kinds = new Set(['http-error', 'connection-failure', 'invalid-json']);

/** Fault-injected fetch for an exact, absolute URL. Each instance is isolated. */
export function createFaultFetch(baseFetch, options) {
  if (typeof baseFetch !== 'function') throw new TypeError('baseFetch must be a function');
  if (typeof options?.url !== 'string') throw new TypeError('url must be an absolute HTTP(S) URL');
  const target = new URL(options.url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new TypeError('Use an absolute HTTP(S) URL without embedded credentials');
  }
  if (!kinds.has(options.kind)) throw new TypeError('Unsupported fault kind');
  const count = options.count ?? 1;
  const method = options.method ?? 'GET';
  const status = options.status ?? 503;
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new TypeError('count must be an integer from 1 to 20');
  if (!/^[A-Z]+$/.test(method)) throw new TypeError('method must be an uppercase HTTP method');
  if (options.kind === 'http-error' && (!Number.isInteger(status) || status < 400 || status > 599)) {
    throw new TypeError('HTTP fault status must be from 400 to 599');
  }
  let applied = 0;
  let matchingRequests = 0;
  const summary = () => ({ kind: options.kind, requested: count, applied, matchingRequests });

  return {
    summary,
    assertApplied() {
      if (applied !== count) {
        const error = new Error(`Expected ${count} fault(s); observed ${applied}.`);
        error.code = 'FAULT_NOT_TRIGGERED';
        error.stats = summary();
        throw error;
      }
      return summary();
    },
    async fetch(input, init) {
      const inputUrl = input instanceof Request ? input.url : input;
      const requestUrl = new URL(inputUrl);
      const requestMethod = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (requestUrl.href !== target.href || requestMethod !== method || signal?.aborted) {
        return baseFetch(input, init);
      }
      matchingRequests += 1;
      if (applied >= count) return baseFetch(input, init);
      // Reserve before any await so concurrent calls cannot over-inject.
      applied += 1;
      if (options.kind === 'connection-failure') throw new TypeError('Injected fetch connection failure');
      if (options.kind === 'http-error') {
        return new Response('{"error":"injected-test-fault"}', { status, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{invalid-json', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}
