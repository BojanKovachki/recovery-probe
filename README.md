# Recovery Probe

**Test whether web and desktop apps show the right data.**

Apps can show the wrong data without any error: a list that disappears after one failed read, a cached screen that never picks up a change, or a row whose state lags behind data the app already received. Recovery Probe reproduces these cases on demand. It injects bounded faults into data reads and compares the screen with a healthy run, or it watches reads and the screen without any fault. Each run writes a local report that separates what it measured from what it suspects.

Use it while you build, not only after. An AI coding agent can call it [over MCP](#use-it-from-an-ai-coding-agent) to see what the screen does when a read fails before it claims the code handles that. `recovery-probe suspects` reads the code a branch changed for error handling that turns a failed read into "no data", and names the read to fail to prove it. `recovery-probe compare` turns the same check, run before and after a change, into evidence for the pull request, `recovery-probe watch` reruns the check and the scan on every save, and `recovery-probe verify` says whether a change is done.

Installing the package does not add recovery behavior to your application.

[![CI](https://github.com/BojanKovachki/recovery-probe/actions/workflows/validate.yml/badge.svg)](https://github.com/BojanKovachki/recovery-probe/actions/workflows/validate.yml)
[![npm](https://img.shields.io/npm/v/recovery-probe.svg)](https://www.npmjs.com/package/recovery-probe)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## See it work

The package includes a deliberately broken app and a corrected one. Both pass the normal loading check; only the corrected one recovers from all three faults.

![Recovery Probe catches a broken retry flow and verifies the corrected flow](docs/demo.svg)

```bash
mkdir recovery-probe-tools && cd recovery-probe-tools
npm install --save-dev --save-exact recovery-probe@0.5.0 playwright@1.62.1
npx playwright install chromium
npx recovery-probe --demo
```

`--demo` exits successfully only when it observes that contrast: the happy path passes, the broken recovery is caught, and the corrected flow passes. Add `--json` to print the full report or `--out report.json` to save it.

## Test your own app

| Goal | Start with | Guide |
| --- | --- | --- |
| Set up a first recovery check interactively | `recovery-probe start web URL` or `start desktop` | [Guided start](docs/start.md) |
| Discover and test the reads behind a screen in a browser or Electron window | `recovery-probe desktop --cdp URL` | [Attachment and HTTP discovery](docs/desktop.md) |
| Compare an Electron screen under IPC faults | `recovery-probe ipc --discover --config FILE` | [IPC setup and discovery](docs/ipc.md) |
| Check what users see when a save or send fails in Electron | `recovery-probe ipc --action --config FILE` | [IPC action check](docs/ipc.md#action-check) |
| Fail an SDK's or main process's own HTTPS connections | `recovery-probe net --rules FILE`, or network steps in `observe --network URL` | [Network faults](docs/net.md) |
| Let an AI coding agent check what the screen does when a read fails | `recovery-probe mcp` | [AI coding agents (MCP)](docs/mcp.md) |
| Find error handling that turns a failed read into "no data", before running anything | `recovery-probe suspects --changed-since main` | [Suspect scanner](docs/suspects.md) |
| Show in a pull request that a change fixed what a check found | `recovery-probe compare --before DIR --after DIR --markdown` | [Before and after](docs/compare.md) |
| See after every save whether an edit fixed or broke what a check found | `recovery-probe watch src -- CHECK` | [Watch mode](docs/watch.md) |
| Check a change before calling it done: its checks improved, nothing regressed, no new suspects | `recovery-probe verify --baseline`, then `recovery-probe verify` | [Verify a change](docs/verify.md) |
| See whether a failure made the app delete local content | `recovery-probe observe --config FILE --files DIR` | [Local files](docs/observe.md#local-files) |
| Inspect an Android app's WebView (experimental) | `recovery-probe android --package NAME` | [Android WebViews](docs/android.md) |
| Test a refresh after content has already loaded | `recovery-probe refresh --config FILE --json` | [Refresh experiments](docs/refresh.md) |
| Watch cached content and row states after user actions, without faults | `recovery-probe observe --config FILE [--steps FILE]` | [Observation](docs/observe.md) |
| Run a repeatable recovery check in CI | `npm run test:ci-example` (source checkout) | [CI example](docs/ci.md) |
| Assert recovery inside your own tests | `withFault` or `createFaultFetch` | [API](docs/api.md) |
| Propose and verify a source change | Opt-in repair workflow | [Repair setup and limits](docs/repair.md) |

`desktop` also attaches to an existing Chromium-based web browser.

**Where it works:**

- **Web apps** in Chromium-based browsers: launch a test browser or attach to an authorized development one.
- **Electron apps that read over HTTP** in the renderer: attach through a loopback debugging endpoint.
- **Electron apps that read over IPC**: add a development-only hook to the main process.
- **JavaScript code that takes a fetch function**: use `recovery-probe/fetch`, without Playwright.
- **Native HTTPS clients that use `HTTPS_PROXY`**, such as an SDK in the main process: fail whole connections per host with `recovery-probe net`.
- **Android WebViews** with WebView debugging enabled (experimental): `recovery-probe android` makes them inspectable like a desktop page. On a Meta Quest, `--keep-awake` lets checks run without anyone wearing the headset.

Desktop support means Electron, not arbitrary native applications. IPC faults do not exercise native networking, HTTP status handling or token refresh. Network faults reach native networking, but only whole connections: they cannot return an HTTP status inside HTTPS. An unsupported data path is inconclusive, never a successful recovery check.

## Use it from an AI coding agent

`recovery-probe mcp` serves the checks as MCP tools, so an agent can verify its own error handling instead of assuming it:

```bash
claude mcp add recovery-probe -- npx recovery-probe mcp
```

The agent can then:
- list the reads behind a page;
- fail one of them and see whether the screen recovers;
- run a network fault proxy for an SDK or a main process;
- find error handling in the changed code that can lose data;
- compare the same check before and after its change;
- run the other commands.

A caught fault comes with a fix brief and a script to reproduce it. The server tells the agent to report outcomes as they are: a pass covers only what was checked, and an inconclusive run is never a pass. See [AI coding agents (MCP)](docs/mcp.md).

## Add a recovery check to a Playwright test

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

If no request matches, `withFault` throws `FAULT_NOT_TRIGGERED` instead of letting the test pass silently. Code that takes a fetch function can use `createFaultFetch` instead. See the [API reference](docs/api.md) and the [JSON-configured runner](docs/runner.md).

## Install

**0.5.0** is the stable release on npm's `latest` channel, and the commands above pin it for reproducible reports. Prereleases use the `next` channel and are opt-in.

Use Node.js 22 or newer. A separate tools folder keeps the tester out of your application's production dependencies. Browser and desktop commands need Playwright; attached targets use their existing browser runtime. If a version is not on npm yet, use the [source installation](CONTRIBUTING.md#install-an-unpublished-source-preview): a GitHub merge alone does not publish the package. See [CHANGELOG.md](CHANGELOG.md) for version history.

When upgrading from 0.4.0, resolve any stored IPC hook path again with `node -p "require.resolve('recovery-probe/ipc')"` and restart the development app. The hook now ships in `dist/`. The library and CLI are compiled from TypeScript; using the published package does not require a build. Source scanning with `suspects` additionally needs the optional TypeScript peer dependency. Experimental commands retain that status in 0.5.0.

## Reports, agents and privacy

Reports separate measured facts, such as fault counts, successful reads, timings and UI changes, from suspected defects. A `CONTENT_LOSS` finding needs review. An unconsumed fault, an unstable control or an unsupported path is inconclusive. Observation findings such as `DELAYED_UI_UPDATE` are leads to check against the application logic, not verdicts.

Coding agents can run saved scenarios, read the JSON evidence, propose a change and rerun the same experiment. Recovery Probe supplies repeatable experiments and evidence; it is not a general bug detector or a production self-healing system.

Reports stay local, and Recovery Probe sends no telemetry. Scenarios, endpoints, channels, selected text, screenshots, login state and command logs may be private, so do not publish them blindly. Request and response bodies and headers are not collected, and observation never records read contents.

Tests and discovery do not call an AI service. Only the opt-in repair workflow, with `--allow-source-upload`, sends the selected source files and bounded observations to your configured OpenAI model; login state and command logs are not part of that upload. It sets `store: false`, which is not a promise of zero provider retention, so review your employer's policy and the provider's data terms first. A repair is a reviewable candidate, not a guaranteed fix.

## Scope

Recovery Probe checks request-level recovery deterministically and observes whether the screen reflects the reads it received. It does not simulate whole-device offline states, WebSocket interruptions, token expiry, browser sleep, slow networks or duplicate submissions.

Structural discovery compares healthy and faulted screens without a hand-written content selector, but it needs a selected read and a stable healthy baseline. No workflow infers your product's intended recovery policy.

The recovery, discovery and refresh workflows reload the renderer to establish controls. That clears in-memory caches, so those modes cannot prove account isolation. Observation keeps that state, but it does not infer identities or data ownership.

Attach only to authorized test sessions, keep debugging endpoints on loopback, and keep the target window visible and uncovered.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and test suites, and [SECURITY.md](SECURITY.md) for reporting security issues. CI runs package checks on Node.js 22 and 24, Chromium integration, and real Electron checks.

## License

[MIT](LICENSE) © 2026 Bojan Kovachki
