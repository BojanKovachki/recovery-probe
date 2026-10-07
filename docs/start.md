# Guided start

This workflow is included in the current preview. See the [README](../README.md) for installation and supported application paths.

Start your app using its normal development command. Recovery Probe does not need its repository or production dependencies. Node 22+ is required. Use a development/test account and backend: a locally running app can still call remote services.

## Three commands for a web app

Install the pinned GitHub preview:

```bash
mkdir recovery-probe-tools && cd recovery-probe-tools
npm install --save-dev github:BojanKovachki/recovery-probe#88fdafe16b513042264b970d0c7bb662112fdf45 playwright@1.62.1
npx recovery-probe start web http://localhost:3000
```

Replace the URL with your web app's local address. The commit pin keeps the install reproducible. GitHub merges do not publish to npm; use a registry version only after confirming that version is available.

The command downloads Chromium if it is missing, opens a visible browser, and guides you through setup:

1. Sign in, navigate to the screen to check, and press Enter in the terminal.
2. Discovery reloads that screen. A single supported GET JSON endpoint is selected automatically; if several appear, choose one from the displayed list.
3. Click one visible piece of loaded data in the browser. The selection click is intercepted; it does not intentionally activate the selected control. Confirm that this content proves the chosen endpoint loaded correctly. Escape cancels selection.
4. Choose automatic recovery, or enter the Retry button's visible label. Confirm the recovery deadline (15 seconds by default).
5. The tool saves the setup, runs all three fault checks and prints results and the local HTML report path.

No JSON editing or CSS selector writing is needed for this guided flow. Buttons with a different accessible name than their visible text may need the existing advanced configuration workflow. Picker selection supports the main page's ordinary DOM, not iframe/shadow-root content. Avoid navigation headings, clocks, random content and broad containers. Short selected text is saved as an additional expectation; use stable test data. Generated structural selectors can become stale after app changes; use `--fresh` to select again. Setup cannot prove that the chosen marker really represents business success—you confirm that relationship.

## Electron

Enable a **loopback debugging port** on the development Electron process once. For a directly launched Electron app:

```bash
npx electron --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 .
```

Forge/custom launchers must forward those flags to Electron, not just the renderer dev server. If necessary use the development-only main-process snippet in [desktop.md](desktop.md). Keep the port local and disable it after testing. Recovery Probe cannot enable debugging on an arbitrary already-running packaged application.

From the tools folder:

```bash
npx recovery-probe start desktop
```

A single window is selected automatically. Multiple windows appear as a title/URL menu, so no separate window-index command is needed. Sign in and navigate, then follow the same request/content choices as the portal. The app stays open after testing. A different port can be supplied with `--cdp http://127.0.0.1:9333`.

## Later runs: one command

From the same tools folder:

```bash
npx recovery-probe start web
# Or:
npx recovery-probe start desktop
```

Reruns reuse the scenario and portal login state without repeating setup. Desktop reruns use the matching page URL, so window ordering does not matter; duplicate matching windows still require a choice. Portal checks can run without a visible window using `start web --headless` after setup. Outputs go into new run folders automatically.

Use `--fresh` to replace setup/refresh an expired login. Use `--dir ./my-private-check` to save another scenario, and supply the same directory when rerunning it. Local setup folders contain a `.gitignore` that ignores all their contents. Authentication state includes cookies/local storage/IndexedDB, not session storage. Session-storage-only authentication needs your existing login fixture and the advanced API workflow.

## Interpret results

- `RECOVERED`: one selected fault occurred, a later matching request succeeded, and the selected content appeared within the deadline.
- `RECOVERY_NOT_OBSERVED`: investigate recovery logic, expected behavior and the deadline; this is not an automatic root-cause diagnosis.
- `BASELINE_FAILED`: normal loading/login/selected content could not be verified; inconclusive.
- `FAULT_NOT_TRIGGERED`: no verified fault; inconclusive.
- `RETRY_ACTION_UNAVAILABLE`: no unique actionable button matched the selected label; inconclusive.

Each run produces `report.html`, `report.json`, the generated `scenario.json`, `reproduce.mjs` and `fix-brief.md`. Exit codes: 0 pass, 1 observed recovery failure, 2 setup/inconclusive. The report checks only the selected GET origin/path and content assertion; query variants share a fault budget. No arbitrary links or action buttons are crawled. Native/Rust/IPC, POST/GraphQL, untouched screens and general non-browser software are outside this version. Service workers are blocked in the portal test browser to make interception reliable; this does not test service-worker behavior.

## Local data and AI

Guided checks do not read repository source code, call AI, or upload their reports. The app still makes its normal requests. Chromium/package installation needs download access. Keep saved authentication, endpoint paths and selected content private, and follow your organization's existing development/testing policies. A local editor using a cloud coding assistant is not local model inference.

Automatic source edits remain a separate opt-in `repair` workflow; no such command is run by guided start. Fully local model generation is not implemented. Playwright handles the browser adapter; the fetch adapter already runs independently of browser automation.
