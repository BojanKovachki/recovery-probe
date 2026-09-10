# Recovery Probe

**Working prototype, version 0.1.** Check whether a web app recovers after a request fails. This repository contains development source; the npm package has not been published. The working name has not been checked for package availability.

**Verified in GitHub Actions:** nine core tests and seven real-browser integration tests passed on Linux/Node 24.20.0 with Chromium 151.0.7922.34. Both the core demonstration and browser demonstration confirmed that the broken example fails recovery while the corrected example passes. [Successful validation run](https://github.com/BojanKovachki/recovery-probe/actions/runs/34432092037)

This verifies the supplied scenarios and synthetic examples, not overall application reliability or customer demand. The tested source revision and results are recorded in `artifacts/test-summary.json`.

A normal test can pass while a Retry button is broken. Recovery Probe runs a normal baseline, injects one controlled failure, and checks the recovery path. It verifies that the intended fault actually happened, so a mistyped endpoint cannot silently produce a successful result.

This prototype includes a deliberately broken example app and a corrected version. Both load normally. In the broken version, a failed request leaves a loading flag set and prevents Retry from doing anything. The corrected version clears that flag.

## Included

- Three deterministic fault recipes: an HTTP error, an interrupted request, and malformed JSON.
- A browser-independent `createFaultFetch` engine, verified with real Node fetch/Response objects and local HTTP.
- A composable `withFault` helper for existing Playwright tests.
- A small JSON-configured runner for automatically loaded GET data with a visible Retry button.
- A bounded fault count, including concurrent requests.
- Cleanup that removes its own route handler while retaining existing user mocks.
- Explicit failure when the fault never triggers, and an inconclusive result when the normal baseline fails.
- Local and browser demonstrations, integration tests and machine-readable reports.

## Install in an existing project

The beta is distributed from GitHub, not the npm registry. While this repository is private, installation requires GitHub access; public beta access begins when the repository is made public.

```bash
npm install --save-dev github:BojanKovachki/recovery-probe
```

For fetch-level tests, import the lightweight entry point. It has no runtime package dependencies and does not require Playwright:

```js
import { createFaultFetch } from 'recovery-probe-prototype/fetch';

const probe = createFaultFetch(fetch, {
  url: 'http://127.0.0.1:3000/api/profile',
  kind: 'http-error',
});

// Use probe.fetch in your application's existing request/test adapter.
// Exercise the failure and the recovery, and assert the expected application state.
probe.assertApplied();
```

The application-specific exercise is required: `assertApplied()` by itself deliberately fails when no matching request was made. This helper does not patch global fetch or discover the application's recovery policy.

For browser tests, install the verified Playwright version and its browser:

```bash
npm install --save-dev playwright@1.62.1
npx playwright install chromium --only-shell
```

Use `import { withFault } from 'recovery-probe-prototype'` in an existing Playwright test, following the example below. The default import's TypeScript declarations require Playwright; the `/fetch` entry point's declarations do not. Pin the GitHub dependency to a commit when adopting it in CI.

## Share usage feedback

If you try this in a project, [tell us what you tested and whether you kept the check](https://github.com/BojanKovachki/recovery-probe/issues/new?template=usage-feedback.md). A public project link is optional. Repeat use, installation problems and unnecessary setup are more useful feedback than a star alone. The library sends no telemetry.

## Run the verified core demonstration

Use Node.js 22 or newer; Node 24.19.0 was exercised locally and Node 24.20.0 was exercised in GitHub Actions. Node 22 compatibility has not been validated. This is source delivered as a prototype; there is no published package to install by name. The core tests/demo require no package installation or browser download.

```bash
npm test
npm run demo
```

The core demo binds an ephemeral port on `127.0.0.1`, uses synthetic data and shuts down afterward. It runs the same controller used by the browser fixture, without executing a DOM or browser engine.

`npm run demo` writes `artifacts/core-demo.json`. The intentionally broken controller is expected to fail the three recovery scenarios. Demo exit code 0 means that this expected distinction was observed, including the corrected controller passing all scenarios. It does not mean the broken controller passed.

## Use the verified fetch engine

```js
import { createFaultFetch } from './src/fetch-fault.mjs';

const probe = createFaultFetch(fetch, {
  url: 'http://127.0.0.1:3000/api/profile',
  kind: 'http-error',
  status: 503,
  count: 1,
});

// Supply probe.fetch to the code under test, then assert the intended recovery.
await exerciseYourApplication(probe.fetch);
probe.assertApplied();
```

`exerciseYourApplication` is the caller's test callback, not an included function. This version matches one exact absolute URL, including its query string, and GET by default. It never replaces global fetch. Later matching requests use the supplied underlying fetch function. Call `assertApplied()` so an unexercised fault fails the test. The browser adapter uses Playwright globs instead of this exact URL match.

## Run browser validation

The adapter's seven integration tests passed in a real Chromium browser in GitHub Actions. The workflow runs on pushes and can also be started manually. It checks bounded faults, incorrect endpoints, failed baselines, concurrent requests, recovery assertions and preservation of existing mocks after cleanup. These checks cover the supplied fixtures; they do not automatically discover recovery flows in other applications.

```bash
npm install
npx playwright install chromium --only-shell
npm run test:browser
npm run demo:browser
```

On Linux, Playwright may also require its documented system dependencies. Browser installation downloads a browser. `demo:browser` writes `artifacts/browser-demo.json`; the checked-in report was recovered from the successful GitHub Actions log. The deliberately broken fixture is expected to fail its three recovery checks; demo exit code 0 means that the expected broken/corrected contrast was verified.

## Check a page under your control

The JSON runner handles a specific flow: visit the page, let it request GET data, show a Retry button after a failure, click Retry and confirm the ready element is visible. It does not automatically discover application flows or determine the correct recovery policy.

Create a scenario file using your development or test environment:

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
node bin/recovery-probe.mjs --config scenario.json --out artifacts/profile.json
```

Exit codes: `0` all configured checks pass; `1` a check failed, was inconclusive or was skipped; `2` command/setup error. The runner creates a fresh context per scenario and blocks service workers so Playwright can intercept requests. Its default assertion checks visibility, not correctness of the displayed data. Use the helper below for stronger application-specific assertions.

## Integrate with an existing Playwright test

For the unpublished source archive, import the helper by its local path:

```js
import { withFault } from './src/index.mjs';

await withFault(page, {
  match: '**/api/profile',
  kind: 'http-error',
  status: 503,
  count: 1,
}, async () => {
  await page.goto('http://127.0.0.1:3000/profile');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('profile-name')).toHaveText('Expected Test User');
});
```

`page` and `expect` above come from the caller's existing Playwright test. The default method is GET. Other methods can be selected explicitly for tests whose side effects you control. The helper allows a string glob or RegExp. The exercise callback must await its requests/assertions before returning and should run inside a test runner with an overall timeout.

Fault kinds:

| Kind | Injected behavior |
|---|---|
| `http-error` | Fulfill the matched request with an error status, default 503. |
| `connection-failure` | Abort the matched request with Playwright's `connectionfailed` reason. |
| `invalid-json` | Return status 200 and an invalid JSON body. |

An aborted request is not a simulation of the entire device going offline. No token expiration, browser sleep, WebSocket interruption, slow-network profile or duplicate submission checking is implemented in version 0.1.

## What a result means

**Pass** means the configured assertion completed after the specified number of injections. It is not a certification of overall app resilience.

**Fail / `RECOVERY_ASSERTION_FAILED`** means the injection was confirmed and the configured expectation did not pass. The test author must decide whether that expectation matches the product's intended behavior.

**Inconclusive / `FAULT_NOT_TRIGGERED`** means the requested fault count was not observed. **`BASELINE_FAILED`** means the ordinary flow failed, so the runner skips fault comparisons. **`INJECTION_ERROR`** means fault setup or cleanup could not be trusted.

The helper attaches the original assertion error as `cause`. The JSON runner records structural outcomes without request bodies, response bodies, headers or full URLs. It does not send telemetry. User-supplied scenario names and assertion code remain the user's responsibility.

## Limits and existing alternatives

Playwright already supports request interception, error responses and aborted requests. Recovery Probe adds a small opinionated workflow around those primitives. Developers can implement equivalent checks themselves. [Playwright network documentation](https://playwright.dev/docs/network)

Shopify's Toxiproxy is an established tool for deterministic network fault injection at the TCP level. This prototype does not claim to invent fault injection or replace that broader tooling. [Toxiproxy](https://github.com/Shopify/toxiproxy)

The current runner changes service-worker/cache behavior through routing, requires correct selectors and endpoint matching, and exercises only the supplied example flow. A caller's page routes can override context routes; register the fault after your own mocks. Full device recovery and production applications have not been validated.

Commercial demand, differentiation, cross-platform support, Firefox/WebKit support, and compatibility beyond the tested runtime remain unverified. There is no cloud service, checkout, customer account system, background monitor, support SLA or paid edition.

## Files

- `src/`: core helper, opinionated runner and TypeScript declarations.
- `bin/`: prototype command-line entry point.
- `examples/`: synthetic local apps.
- `test/`: core and real-browser integration tests.
- `artifacts/`: saved demonstration results and their GitHub Actions provenance.

License: MIT. The npm package is deliberately marked private while it is an unpublished prototype.
