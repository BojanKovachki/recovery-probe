# Library API

The library adds bounded faults to tests you already have. `recovery-probe` needs Playwright; `recovery-probe/fetch` has no runtime dependencies.

## Fault kinds

| Kind | Injected behavior |
| --- | --- |
| `http-error` | Fulfils the matched request with an HTTP error status; defaults to `503`. |
| `connection-failure` | Aborts the matched Playwright request with `connectionfailed`, or throws from the fetch adapter. |
| `invalid-json` | Returns status `200` with a deliberately malformed JSON body. |

Faults are bounded by `count` (default `1`, maximum `20`). The count is reserved synchronously, so concurrent matching requests cannot over-inject.

## `withFault(page, options, exercise)`

Installs one temporary Playwright route, runs `exercise`, verifies the requested fault count, and removes only that route handler. See the [README example](../README.md#use-it-in-your-tests).

```ts
interface FaultOptions {
  match: string | RegExp;
  kind: 'http-error' | 'connection-failure' | 'invalid-json';
  status?: number;
  count?: number;
  method?: string;
}
```

If the endpoint does not match, it throws `FAULT_NOT_TRIGGERED` instead of allowing the test to pass silently. If the fault is applied but the recovery assertion fails, it throws `RECOVERY_ASSERTION_FAILED` and retains the original assertion error as `cause`.

Register the fault after your own route mocks. The helper uses `route.fallback()` for requests it does not inject, allowing earlier handlers to continue processing them.

## `createFaultFetch(baseFetch, options)`

Creates an isolated fetch wrapper for one exact URL and method. It returns `{ fetch, summary, assertApplied }` and never patches global `fetch`. The URL must be absolute and matches exactly, including its query string. Every other request, including a relative one such as `fetch('/api/x')`, reaches the supplied fetch untouched.

```js
import { createFaultFetch } from 'recovery-probe/fetch';

const probe = createFaultFetch(fetch, {
  url: 'http://127.0.0.1:3000/api/profile',
  kind: 'connection-failure',
});

await exerciseApplication(probe.fetch);
probe.assertApplied();
```

`exerciseApplication` represents your own test adapter or application controller. Calling `assertApplied()` is essential: it proves that every requested fault was consumed.

## `startNetworkFaultProxy(options)`

From `recovery-probe/net`. Starts a loopback HTTPS proxy that refuses, resets, stalls or delays whole connections per host, for clients that use `HTTPS_PROXY`. It returns `url`, `env()`, `arm(rules)`, `disarm()`, `dropOpen(host)`, `events()`, `summary()`, `assertApplied()` and `close()`. With `control: true`, another process can drive it through `connectNetworkFaults(url)`, which has `arm`, `disarm`, `dropOpen` and `summary`. See [Network faults](net.md).

## `recovery-probe mcp`

Not an import: the command serves the checks to AI coding agents as MCP tools over stdio. See [AI coding agents (MCP)](mcp.md).

## `probeRecovery(browser, config)`

Runs the baseline and the three default recovery checks used by the [JSON-configured runner](runner.md). For custom interactions or stronger assertions, prefer `withFault` inside your own test.

## When plain Playwright routes are enough

Playwright already provides the routing primitives used here. Recovery Probe adds bounded recipes, fault-occurrence verification, cleanup, consistent result codes, a fetch adapter, and a runnable broken-versus-fixed example. If a few direct `page.route()` calls are clearer for your test, use them; this package is most useful when teams want the recovery pattern to be repeatable.
