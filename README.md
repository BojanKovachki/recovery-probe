# Recovery Probe

**Test how web and desktop applications recover when data reads fail—during loading and refresh.**

Recovery Probe injects bounded faults, compares healthy and faulted screens, and records whether content survives or returns. It helps developers and coding agents reproduce recovery problems such as disappearing lists, stuck loading states and missing retries. Installing the package does not add recovery behavior to your application.

[![CI](https://github.com/BojanKovachki/recovery-probe/actions/workflows/validate.yml/badge.svg)](https://github.com/BojanKovachki/recovery-probe/actions/workflows/validate.yml)
[![npm](https://img.shields.io/npm/v/recovery-probe.svg)](https://www.npmjs.com/package/recovery-probe)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Supported applications

| Application path | What can be tested | Setup |
| --- | --- | --- |
| Web apps in Chromium-based browsers | Renderer GET fetch/XHR failures, UI recovery and structural content changes | Launch a test browser or attach to an authorized development browser |
| Electron desktop apps using renderer HTTP | The same request and UI checks | Attach through a loopback debugging endpoint |
| Electron desktop apps using IPC reads | Renderer behavior after selected IPC rejections or null results | Add a development-only handler-registration hook and enable local inspection |
| JavaScript code using fetch | Recovery logic around an explicitly supplied fetch wrapper | Import `recovery-probe/fetch`; Playwright is not required |

Desktop support currently means Electron, not arbitrary native applications. IPC faults do not exercise native/Rust networking, HTTP status handling or token refresh. An unsupported data path is inconclusive, never a successful recovery check.

## Install

**0.3.0** is the stable release target on npm's `latest` channel. The commands below pin the version for reproducible reports. Prereleases use `next` and are opt-in.

```bash
mkdir recovery-probe-tools && cd recovery-probe-tools
npm view recovery-probe@0.3.0 version
npm install --save-dev --save-exact recovery-probe@0.3.0 playwright@1.62.1
npx recovery-probe --version
```

If the version check reports that the version is unavailable, npm publication is still pending; use the [source installation](CONTRIBUTING.md#install-an-unpublished-source-preview). A GitHub merge alone does not publish the package. Use Node.js 22 or newer. A separate tools folder keeps the tester out of your application's production dependencies. Browser/desktop commands require Playwright; attached targets use their existing browser runtime. The guided web flow downloads Chromium when needed. See [CHANGELOG.md](CHANGELOG.md) for version history.

For the 0.4 observation preview, install `recovery-probe@0.4.0-preview.2` (the `next` channel) with the same Playwright version. Preview.2 adds formatting, lint and implementation type checks; the action/row observation features were introduced in preview.1.

## Choose a workflow

**New in 0.3.0:** guided setup, HTTP/IPC discovery, refresh experiments and [fault-free observation](docs/observe.md) extend the original recovery helpers. Observation records selected reads and content while you navigate without reloading or clearing caches. Lightweight sampling, phase timings and separate cleanup evidence make capture cost and scope explicit. Use `"detail": "region"` for full DOM diagnostics.

Content comparisons preserve the first observed result and summarize later samples: a temporary difference can subsequently match the baseline, or diverge again. These are observations, not ownership, freshness or stability verdicts. See the guide for updating the development IPC hook before capturing cached state; see the changelog for upgrading from 0.2.0.

| Goal | Entry point | Guide |
| --- | --- | --- |
| Set up a first request-recovery check interactively | `recovery-probe start web URL` or `start desktop` | [Guided start](docs/start.md) |
| Discover and test renderer reads in an existing browser or Electron window | `recovery-probe desktop --cdp URL` | [Attachment and HTTP discovery](docs/desktop.md) |
| Compare an Electron screen under IPC faults | `recovery-probe ipc --discover --config FILE` | [IPC setup and discovery](docs/ipc.md) |
| Test a refresh after content has already loaded | `recovery-probe refresh --config FILE --json` | [Refresh experiments](docs/refresh.md) |
| Observe cached content without a reload | `recovery-probe observe --config FILE` | [Observation](docs/observe.md) |
| Time row states after a user action, with optional scripted steps | `recovery-probe observe --config FILE [--steps FILE]` | [Actions, rows and delayed UI updates](docs/observe.md#actions-tracked-rows-and-delayed-ui-updates) |
| Run a repeatable synthetic recovery check in CI | `npm run test:ci-example` (source checkout) | [CI example](docs/ci.md) |
| Add an explicit recovery assertion to a test | `withFault` or `createFaultFetch` | Examples below |
| Propose and verify a source change | Opt-in repair workflow | [Repair setup and limits](docs/repair.md) |

`desktop` is also the current command name for attaching to an existing Chromium-based web browser. Use only an authorized test session, with debugging endpoints on loopback. Keep the target window visible and uncovered.

Guided setup asks you to choose a request and loaded content that proves success; later runs reuse the saved scenario. Structural discovery compares healthy and faulted screens without requiring a hand-written content selector, but still needs a selected read target and a valid baseline. Neither workflow infers your product's intended recovery policy.

HTTP and IPC structural discovery calibrate three healthy reloads for the full `baselineTimeoutMs` window before injecting faults (45 seconds with the default 15-second window). All three stable end states must agree. This avoids treating a briefly stable loading shell as the healthy screen, accepts legitimate empty regions, and keeps an unsuccessful calibration inconclusive. Later controls may finish early once they match the calibrated baseline. Content arriving after the window remains outside the evidence.

**Session-isolation boundary:** recovery/discovery/refresh workflows reload the renderer to establish controls. That clears in-memory caches and can hide state carried between sessions. Those modes cannot prove account isolation; content preservation within one session is not an ownership check. The new observation workflow collects evidence without resetting that state, but does not infer identities or data ownership.

## Refresh experiments

Refresh mode tests an **already populated screen** using an explicitly configured synthetic window event, such as `online`. It first checks the event without a fault, then injects the next selected read failure and observes the screen without reloading. An optional second event tests whether another refresh repairs the screen.

```bash
npx recovery-probe refresh --config ./refresh.json --out ./refresh-run1 --json
```

This dispatches an event; it does not disconnect the network, change `navigator.onLine`, simulate sleep/resume or expire authentication. Spontaneous recovery and recovery after the second tool event are reported separately. See the [configuration, results and cleanup contract](docs/refresh.md).

## Reports and coding agents

Reports separate measured facts—fault counts, successful reads, timings and UI changes—from suspected defects. A `CONTENT_LOSS` finding needs review. An unconsumed fault, unstable control or unsupported path is inconclusive. All non-recovery observations are limited to the configured time window.

Agents can run saved scenarios, inspect JSON evidence, propose changes and rerun the same experiment. Recovery Probe supplies repeatable experiments and evidence; it is not a general bug detector or production self-healing system. The optional AI repair workflow requires selected local source files, launch/test commands and your own model credentials. It produces a reviewable candidate, not a guaranteed fix.

Reports remain local. Scenarios, endpoints, channels, selected text and authentication files may contain private information; do not publish them blindly. Tests and discovery do not call an AI service.

![Recovery Probe catches a broken retry flow and verifies the corrected flow](docs/demo.svg)

## Use in a Playwright test

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

## Library HTTP faults

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

## Original JSON-configured runner

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

## Original runner result semantics

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

The original assertion-based runner requires explicit selectors and endpoint matching; structural discovery and refresh modes use healthy-screen comparisons instead. It does not discover an application's recovery policy automatically. Request/response bodies and headers are not collected by the checker. Preview reports include endpoint origin/path, selectors, expected text and configuration; optional screenshots, login state and command logs may be sensitive. Do not commit or share these blindly.

Recovery Probe sends no telemetry. Tests/discovery do not call an AI service. Only explicit repair generation with `--allow-source-upload` sends the selected source contents and bounded observations to the configured OpenAI model. Login state and command logs are not part of that upload bundle. `store: false` is set on the API request; this is not a promise of zero provider retention. Review employer policy and provider data terms first.

## Development

```bash
npm ci
npm test                 # fetch/core tests
npm run test:package     # isolated tarball install + TypeScript + CLI checks
npx playwright install chromium
npm run test:browser     # real-browser integration tests
npm run test:repair      # safety, authenticated portal, before/after pipeline
# After installing the optional Electron test runtime:
npm run test:repair:electron
npm run demo:browser
```

CI runs package checks on Node.js 22 and 24, Chromium integration, and real Electron checks. Repair integration tests use a **controlled mock model response** but real apps, fault injection, source changes and reruns. They validate orchestration, not live AI diagnosis quality. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Bojan Kovachki
