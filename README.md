# Recovery Probe

[![CI](https://github.com/BojanKovachki/recovery-probe/actions/workflows/validate.yml/badge.svg)](https://github.com/BojanKovachki/recovery-probe/actions/workflows/validate.yml)
[![npm](https://img.shields.io/npm/v/recovery-probe.svg)](https://www.npmjs.com/package/recovery-probe)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Deterministic fault injection for testing whether web applications actually recover after failed requests.**

A happy-path test can pass while a Retry button is completely broken. Recovery Probe adds a small, explicit workflow around Playwright routing and `fetch`: inject one controlled failure, exercise the application's recovery path, and prove that the intended fault really occurred.

![Recovery Probe catches a broken retry flow and verifies the corrected flow](docs/demo.svg)

## What it catches

Consider an application that loads normally, but forgets to clear its loading state after an error. Its ordinary end-to-end test stays green. After a transient `503`, interrupted request, or malformed response, Retry does nothing.

Recovery Probe makes that failure deterministic:

1. Match one endpoint and request method.
2. Inject a bounded fault without replacing global `fetch`.
3. Run the real recovery interaction and assertion.
4. Fail if the fault was never observed, so a wrong route cannot create a false positive.
5. Remove only its own route handler and preserve existing mocks.

## Electron desktop preview

The `feat/desktop-recovery-check` branch adds a development-only Electron renderer checker: discover GET JSON endpoints, inject a selected fault, exercise Retry or automatic recovery, and write a local HTML report plus an executable reproduction and fix-investigation brief. See [the desktop setup guide](docs/desktop.md). This preview requires one data-dependent UI assertion and does not patch application source. npm 0.2.0 does not include it.

## Install

Recovery Probe is designed to be added to an existing Playwright project:

```bash
npm install --save-dev recovery-probe
```

Node.js 22 or newer is required. Playwright is an optional peer dependency: the fetch-only API works without it, while the browser helper and CLI require Playwright 1.62.1 or newer.

## Quick start

Use `withFault` inside an existing Playwright test. The callback contains the real user action and the application-specific recovery assertion.

```js
import { test, expect } from '@playwright/test';
import { withFault } from 'recovery-probe';

test('profile recovers after a transient 503', async ({ page }) => {
  const stats = await withFault(page, {
    match: '**/api/profile',
    kind: 'http-error',
    status: 503,
    count: 1,
  }, async () => {
    await page.goto('http://127.0.0.1:3000/profile');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('profile-name')).toHaveText('Test User');
  });

  expect(stats.applied).toBe(1);
});
```

If the endpoint does not match, Recovery Probe throws `FAULT_NOT_TRIGGERED` instead of allowing the test to pass silently. If the fault is applied but the recovery assertion fails, it throws `RECOVERY_ASSERTION_FAILED` and retains the original assertion error as `cause`.

## Run the demonstration

The repository includes deliberately broken and corrected applications. Both pass their normal loading check; only the corrected application recovers from all three faults.

```bash
npm install
npx playwright install chromium
npx recovery-probe --demo
```

The command prints a concise comparison:

```text
broken synthetic fixture
  PASS         Normal connection (OK)
  CAUGHT       HTTP 503 once (RECOVERY_ASSERTION_FAILED, injected 1)
  CAUGHT       Interrupted request once (RECOVERY_ASSERTION_FAILED, injected 1)
  CAUGHT       Malformed JSON once (RECOVERY_ASSERTION_FAILED, injected 1)

fixed synthetic fixture
  PASS         Normal connection (OK)
  PASS         HTTP 503 once (OK, injected 1)
  PASS         Interrupted request once (OK, injected 1)
  PASS         Malformed JSON once (OK, injected 1)
```

`--demo` exits successfully only when it observes the expected contrast: the happy path passes, the broken recovery is caught, and the corrected flow passes. Add `--json` to print the full report or `--out report.json` to save it.

## Supported faults

| Kind | Injected behavior |
| --- | --- |
| `http-error` | Fulfils the matched request with an HTTP error status; defaults to `503`. |
| `connection-failure` | Aborts the matched Playwright request with `connectionfailed`, or throws from the fetch adapter. |
| `invalid-json` | Returns status `200` with a deliberately malformed JSON body. |

Faults are bounded by `count` (default `1`, maximum `20`). The count is reserved synchronously, so concurrent matching requests cannot over-inject.

## Fetch-only tests

The lightweight `recovery-probe/fetch` entry point has no runtime dependencies and does not require Playwright. It matches one exact absolute URL, including its query string, and never patches global `fetch`.

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

## JSON-configured runner

The CLI supports pages that automatically load GET data, expose a visible Retry button after failure, and show a ready element after recovery.

```json
{
  "name": "Profile recovery",
  "url": "http://127.0.0.1:3000/profile",
  "requestPattern": "**/api/profile",
  "readySelector": "[data-testid=profile-ready]",
  "retrySelector": "[data-testid=profile-retry]",
  "timeoutMs": 3000
}
```

```bash
npx recovery-probe --config recovery-probe.json --out artifacts/profile-recovery.json
```

The runner first checks the normal baseline in a fresh browser context. If that baseline fails, fault comparisons are skipped and reported as inconclusive. Each fault then receives its own fresh context with service workers blocked so Playwright can intercept the request.

Exit codes:

- `0`: every configured check passed, or the controlled demo observed its expected broken-versus-fixed result.
- `1`: a recovery check failed, was inconclusive, or was skipped.
- `2`: invalid arguments, configuration, or environment setup.

## Result semantics

| Code | Meaning |
| --- | --- |
| `OK` | The configured assertion completed and the expected fault count was observed. |
| `RECOVERY_ASSERTION_FAILED` | The fault occurred, but the recovery assertion did not pass. |
| `FAULT_NOT_TRIGGERED` | The requested fault count was not observed. Check the route, method, cache, and service worker. |
| `BASELINE_FAILED` | The ordinary flow failed, so the runner could not make a useful fault comparison. |
| `INJECTION_ERROR` | Playwright could not apply or clean up the route reliably. |

A passing result proves the configured recovery behavior for that test. It is not a certification of overall application resilience.

## API

### `withFault(page, options, exercise)`

Installs one temporary Playwright route, runs `exercise`, verifies the requested fault count, and removes only that route handler.

```ts
interface FaultOptions {
  match: string | RegExp;
  kind: 'http-error' | 'connection-failure' | 'invalid-json';
  status?: number;
  count?: number;
  method?: string;
}
```

Register the fault after your own route mocks. The helper uses `route.fallback()` for requests it does not inject, allowing earlier handlers to continue processing them.

### `createFaultFetch(baseFetch, options)`

Creates an isolated fetch wrapper for one exact URL and method. It returns `{ fetch, summary, assertApplied }` and leaves the supplied fetch function unchanged.

### `probeRecovery(browser, config)`

Runs the baseline and the three default recovery checks used by the JSON CLI. For custom interactions or stronger assertions, prefer `withFault` inside your own test.

## Scope

Recovery Probe deliberately focuses on deterministic request-level recovery checks. It does not simulate whole-device offline states, WebSocket interruptions, token expiry, browser sleep, slow-network profiles, or duplicate-submission safety.

Playwright already provides the routing primitives used here. Recovery Probe adds bounded recipes, fault-occurrence verification, cleanup, consistent result codes, a fetch adapter, and a runnable broken-versus-fixed example. If a few direct `page.route()` calls are clearer for your test, use them; this package is most useful when teams want the recovery pattern to be repeatable.

The runner requires explicit selectors and endpoint matching. It does not discover an application's recovery policy automatically. Reports contain structural outcomes and environment versions, not request bodies, response bodies, headers, or full target URLs. Recovery Probe sends no telemetry.

## Development

```bash
npm ci
npm test                 # 9 fetch/core tests
npm run test:package     # isolated tarball install + TypeScript + CLI checks
npx playwright install chromium
npm run test:browser     # 7 real-browser integration tests
npm run demo:browser
```

CI runs package checks on Node.js 22 and 24, then runs the integration suite and controlled demo in Chromium. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

[MIT](LICENSE) © 2026 Bojan Kovachki
