# Try the desktop recovery preview

For the new guided workflow without window-index lookup or JSON editing, see [guided start](start.md) (preview.3). The explicit configuration workflow below remains supported.

This preview attaches to a running **Electron development app**. It discovers renderer GET JSON requests, then tests one selected endpoint against a UI assertion you configure once. It does not scan source code, patch files, or add runtime recovery to the application.

You can run the tester in a separate folder; your desktop application's production dependencies do not change. Use Node.js 22 or newer for the tester. Electron itself may use a different bundled Node version.

## Attachment and networking coverage

The upcoming preview.3 attaches with `noDefaults: true`. This avoids Playwright's default download-behavior override, which older Electron versions can reject with `Browser.setDownloadBehavior: Browser context management is not supported`. It also preserves the application's focus/media defaults. CI covers Electron 29.0.1 and 44.5.1 with real renderer fault checks and guided reruns. Keep the test window visible; attachment does not disable app background throttling.

A successful connection does not establish that the app uses supported networking. If its preload forwards data reads through IPC to Rust or another main-process client, renderer discovery may correctly find no GET JSON requests. Use the explicit [IPC registration adapter](ipc.md) in preview.4 for renderer recovery after IPC rejection/null results; it does not test Rust transport. Do not keep changing selectors or report the absence of requests as a pass. A browser build using fetch can be tested with `web`, but the result only applies to that build's path.

## 1. Start the development app with a local debugging port

For an app launched directly with Electron:

```bash
npx electron --remote-debugging-port=9222 .
```

For a custom development script, pass `--remote-debugging-port=9222` to the **Electron process**, not just the frontend dev server. If the script does not forward arguments, add this before `app.whenReady()` in the development-only main-process startup:

```js
if (!app.isPackaged && process.env.RECOVERY_PROBE === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}
```

Set `RECOVERY_PROBE=1` using your existing cross-platform development tooling, then start the app normally. Keep the debugging endpoint on loopback, never expose port 9222 publicly, and remove/disable it after testing. Sign in with a test account and open the page you want to check. Keep the app window visible and unminimized while testing; Chromium can throttle a hidden renderer, preventing reliable user-like clicks. Save unfinished work first: checks reload this window and click only your configured Retry control.

## 2. Install and identify the window

Install the published preview in a separate tester folder:

```bash
mkdir recovery-probe-desktop-test
cd recovery-probe-desktop-test
npm init -y
npm install --save-dev recovery-probe@0.3.0-preview.2 playwright@1.62.1
npx recovery-probe desktop --list
```

**Installing `recovery-probe` from npm without the preview version still installs 0.2.0 and does not include this preview.** Use an explicit preview version to keep installations reproducible.

No Chromium download is needed: the tester connects to the Chromium already running inside your Electron app. `--list` prints window indexes and page URLs with query strings/fragments omitted. If there are multiple windows, select the intended one explicitly.

## 3. Discover the page's API requests

For window 0:

```bash
npx recovery-probe desktop --discover --page 0 --out .recovery-probe/discovery
```

This reloads the page, observes successful GET fetch/XHR JSON responses for five seconds, and writes `discovery.json` and a `scenario.json` template. Extend discovery with `--duration 15000` if startup is slower. Choose a page that reloads into the desired route and makes the relevant request during loading.

If no endpoints appear, do not interpret this as healthy behavior. The screen may use Rust/native/IPC requests, cached data, a service worker, POST/GraphQL requests, or requests outside the observation window. These are not covered by this version. Changing frontend selectors cannot make native SDK traffic interceptable; that needs a separate SDK test adapter.

## 4. Define what successful recovery looks like

Edit `.recovery-probe/discovery/scenario.json`. Discovery fills the page identity and the endpoint when there is only one candidate. For example:

```json
{
  "cdp": "http://127.0.0.1:9222",
  "page": 0,
  "pageUrl": "http://localhost:3000/",
  "endpoint": "https://api.example.test/community",
  "readySelector": "[data-testid=community-loaded]",
  "busySelector": "[data-testid=community-loading]",
  "retrySelector": "[data-testid=community-retry]",
  "recovery": "retry",
  "timeoutMs": 8000
}
```

Use your real selectors and one endpoint from discovery. **Choose a ready marker that appears only when that endpoint's data has loaded**, not a permanent heading, navigation bar or app shell. It must match exactly one visible element. If necessary add a `data-testid` to an existing loaded-state element. This is the one app-specific assertion the tool cannot safely infer.

- `readyText` optionally requires text inside the ready element.
- `busySelector` optionally requires all matching loading elements to be hidden.
- Set `recovery` to `automatic` and omit `retrySelector` if the app retries without a button.
- `faults` can narrow the check to `["http-error"]`, `["connection-failure"]`, or `["invalid-json"]`; the default runs all three.
- `timeoutMs` is each wait's limit (200–60000 ms), not a total run deadline. Allow enough time for intentional retry backoff.
- `endpoint` matches an exact origin and path, GET only, in the main renderer frame. Query values are omitted and all query variants share the single injected-failure budget. Select a page where that is the intended request scope.
- `pageUrl` is the discovery identity without query strings or fragments. Current query/hash navigation is preserved by reload; navigate to the same screen before every run.

## 5. Run and inspect

```bash
npx recovery-probe desktop --config .recovery-probe/discovery/scenario.json --out .recovery-probe/first-run
```

Open `.recovery-probe/first-run/report.html` in your browser. Add `--screenshots` to capture failed/inconclusive fault states locally. Screenshots can contain private information; none are captured by default. Endpoint paths, selectors and configured ready text can also be private. Keep `.recovery-probe/` out of your app's Git repository and review files before sharing.

For each selected fault the checker:

1. Reloads without a fault and verifies that the chosen endpoint succeeds and the ready marker appears.
2. Reloads with one injected failure: HTTP 503, interrupted request, or malformed JSON.
3. Clicks the configured Retry button, or waits for automatic recovery.
4. Requires a later successful matching request **and** the ready marker/busy condition. A stale marker alone cannot pass; the injected malformed JSON HTTP 200 is not counted as a recovery response.
5. Removes its own route handler. After all checks, reloads once without faults to reset the page and disconnects, leaving the app running.

A reload reset is not a Retry success. If Retry remains broken but reloading rescues the page, the original result stays FAIL.

| Result | Meaning |
| --- | --- |
| `RECOVERED` | The selected fault, action, subsequent successful request and UI assertion were verified. |
| `RECOVERY_NOT_OBSERVED` | Recovery did not meet those expectations before the deadline. Investigate the app and the assertion. |
| `BASELINE_FAILED` | The healthy run could not be established; no fault was injected for that row. |
| `FAULT_NOT_TRIGGERED` | The selected failure could not be verified; not a confirmed app bug. |
| `RETRY_ACTION_UNAVAILABLE` | The configured button was absent, ambiguous or not actionable; check the selector and recovery mode. |
| `INJECTION_ERROR` / `CLEANUP_FAILED` | Interception was unreliable; stop and investigate the harness. |

Exit code 0 means all checks and final reset passed, 1 means a recovery failure was observed, and 2 means setup or the result was inconclusive.

## Reproduce and work toward a fix

Each run writes:

- `report.html`: readable findings.
- `report.json`: structured observations and fault counts.
- `scenario.json`: the exact configuration used.
- `reproduce.mjs`: executable regression check. Run `node .recovery-probe/first-run/reproduce.mjs` from your tester folder while the app is on the same screen.
- `fix-brief.md`: instructions and evidence for a coding agent with authorized access to the app's source.

The fix brief does not claim a root cause. Give it to your local coding agent along with the scenario/report, reproduce the failure, review a proposed patch, and rerun the same test. No source code is uploaded or changed by Recovery Probe.

A pass is limited to the selected UI assertion and request path. It does not verify business correctness, native download queues, VR session recovery, login/token expiry, WebSockets or the rest of the app.

## Validation

The integration suite launches a real Electron BrowserWindow with context isolation and a preload bridge, attaches through CDP, discovers its API call, checks deliberately broken/fixed/automatic/stale-marker fixtures, checks the CLI reports, and verifies that disconnecting leaves the app alive. Run it with an Electron runtime installed; Linux CI uses Xvfb:

```bash
npm install --no-save --package-lock=false electron@44.5.1
npm run test:desktop:electron
```

Actual compatibility with your application's Electron version and its startup/network design still needs your first local run.

## Repeated HTTP faults and browser attachment (preview.7)

The existing explicit verifier accepts `times` (integer 1–10, default 1), `baselineTimeoutMs` and `recoveryTimeoutMs` (default to the existing `timeoutMs`). All requested faults must be consumed; a partially consumed plan is `FAULT_NOT_TRIGGERED`, never a pass. Every injected malformed JSON HTTP-200 response is excluded from later successful responses. Successful checks now report sampled `recoveryMs` from the first injection.

For an already authorized, separately configured Chromium/Edge test session, use the browser name rather than `desktop`:

```bash
npx recovery-probe web --attach --config ./scenario.json --cdp http://127.0.0.1:9223
```

This reuses the live page and its sessionStorage through reloads. It does not export credentials, create a managed device identity or bypass sign-in policy. CDP must be loopback-only. Sign in normally in a testing session you are permitted to automate. The tool disconnects at the end and leaves the browser open. List windows with `web --attach --list --cdp URL`. Observe endpoints with `web --attach --discover --page N --cdp URL` (no config); a config switches discovery to fault experiments. The older desktop spellings still work.

### Structural HTTP discovery

```bash
npx recovery-probe web --attach --discover --config ./scenario.json --cdp http://127.0.0.1:9223
```

Minimal scenario:

```json
{
  "endpoint": "http://localhost:3000/api/items",
  "pageUrl": "http://localhost:3000/items",
  "times": 2,
  "faults": ["http-error", "connection-failure", "invalid-json"],
  "requiredEndpoints": [],
  "baselineTimeoutMs": 15000,
  "recoveryTimeoutMs": 8000,
  "settleMs": 800,
  "repeats": 3
}
```

The selected request must be a read-only renderer GET fetch/XHR. Query variants share its origin/path budget. No form actions, navigation or mutation injection is performed. Persistent faults and timed outages are not implemented. Discovery uses `times` for each listed fault, does not infer the retry policy, and does not click Retry. For retry-button assertions use the existing explicit verifier.

Three healthy baselines precede experiments. A healthy control precedes every faulted reload and a healthy cleanup follows. Default three-fault/three-repeat plan uses 22 reloads. Existing readiness selectors/text are ignored and omitted from saved discovery scenarios. Use `requiredEndpoints` for known relevant dependencies. Other observed traffic is recorded under `coverage` without gating readiness. Non-GET requests are explicitly unsupported; unselected GETs are untested. Paths may be sensitive even when query values and bodies are omitted. No service-worker, native or unobserved traffic coverage is implied.

Reports share the preview.7 IPC observation/interpretation fields; see [structural discovery](ipc.md#structural-discovery-preview7). Distribution shifts and structural replacement candidates are observations, not determinations of correct roles, permissions or semantics. Evidence includes fault counts and sampled recovery time; time windows cannot establish that an app will never heal. Baseline timing is measured separately. Request duration is measured from request to completion using a monotonic clock, including body transfer.

`--restore-window` opts into reversible un-minimizing. Keep non-minimized windows uncovered. Exit 0 means informational results and healthy cleanup; exit 2 means findings need review or the run is inconclusive. Heuristics never use exit 1 as a verified bug verdict. Repeat the same command with the saved `scenario.json` after a proposed local fix.

Git Bash may rewrite URL fragments such as `#/route`; pass them in JSON configuration or use `MSYS_NO_PATHCONV=1` when invoking a command that accepts them. Do not change routes solely to make assertions pass.
