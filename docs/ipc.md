# IPC renderer recovery preview

This adapter is in `0.3.0-preview.6` on GitHub, not yet published to npm. It tests renderer recovery after **one rejected IPC invocation**, or optionally **one successful null result**. It does not simulate HTTP status codes, Rust transport failures, token refresh, connection banners or native retry behavior. Use only read-only channels in a development build with known fixture data.

Unlike renderer HTTP routing, this boundary requires a small main-process hook. The local agent can perform the setup below; no interactive picker is required. Do not edit generated client files or access Electron's private handler map.

## 1. Install in a separate tools folder

Node 22+ is required for the CLI. Electron 29's bundled Node can load the small CommonJS hook; it does not load Playwright into your main process.

```bash
mkdir -p recovery-probe-tools && cd recovery-probe-tools
npm install --save-dev github:BojanKovachki/recovery-probe#main playwright@1.62.1
node -p "require.resolve('recovery-probe/ipc')"
```

Pin the tested commit for reproducible installs. Record the absolute path printed by the last command. After npm publication, use `recovery-probe@0.3.0-preview.6` instead of the GitHub reference. Chromium need not be downloaded: the checker attaches to Electron.

## 2. Add a development-only registration hook

Before generated clients call `initIpc()` / register handlers, load the hook from the separate tools installation. The following is a CommonJS-style example; adapt to the project's existing module system and actual window getter:

```js
if (!app.isPackaged && process.env.RECOVERY_PROBE_IPC === '1') {
  const { installIpcProbe } = require(process.env.RECOVERY_PROBE_IPC_MODULE);
  globalThis.__recoveryProbeIpc = installIpcProbe(ipcMain, {
    enabled: true,
    channels: ['ExampleFiles::read', 'ExampleFiles::versions'],
    sender: () => mainWindow?.webContents,
  });
}
// Existing generated client initialization follows, unchanged.
```

Replace channel names with the exact existing read channels. Include the second channel if its result gates visible rows. `sender()` must return only the intended main window's WebContents; it may initially return undefined before that window exists. The dispatcher faults only that sender's main-frame calls. Background direct method calls, other windows and child frames do not consume the fault.

Set `RECOVERY_PROBE_IPC=1` and `RECOVERY_PROBE_IPC_MODULE` to the absolute `.cjs` path from step 1 when starting the development app. No company application's production dependency needs changing. Do not expose controls through preload or contextBridge.

Registration is captured using the public `ipcMain.handle` API. Install before registration, once per process. Unaffected calls keep their original arguments, receiver and return value/Promise. The adapter observes completion without recording arguments, results or full errors. Calling `dispose()` disarms and restores the registration function; existing dispatchers become transparent. Restart the development app to remove them entirely.

## 3. Enable both local debugging interfaces

Use the actual development startup command with these flags reaching **Electron**:

```text
--inspect=127.0.0.1:9229
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
```

If startup already enables the Node inspector, inspect its actual port rather than adding a conflicting flag. The Node inspector controls the main-process probe; CDP observes the renderer. Both must remain loopback-only and be disabled after testing. Inspector access can execute main-process code; it is a development interface, not a production service.

Sign in with a fixture account, open the intended route, and keep the window visible and online. Preserve hash navigation; when passing a `#/route` through Git Bash tooling, check that MSYS path conversion has not rewritten it. The checker uses the actual target WebContents URL, including hash/query, and reloads the existing page without requiring a route argument.

## 4. Generate one local scenario

The local agent should derive this configuration from the real handler names, retry policy and DOM. It should not guess the spinner selector or choose a row that virtualization hides. A fixture account with one known file is the simplest setup, not a library requirement. An existing authorized staging account can also be used if the agent verifies one uniquely selected, fully loaded file row remains visible after a fresh reload under the actual sort/filter. Do not use an all-rows selector on a large virtualized table or modify account data merely to make the assertion pass. If no reliable visible marker is available, stop and request suitable fixture data.

```json
{
  "cdp": "http://127.0.0.1:9222",
  "inspector": "http://127.0.0.1:9229",
  "channel": "ExampleFiles::read",
  "requiredChannels": ["ExampleFiles::versions"],
  "readySelector": "[data-testid='fixture-file-row']",
  "readyText": "rp-fixture-cube.fbx",
  "busySelector": "[data-testid='files-spinner']",
  "faults": ["rejection"],
  "baselineTimeoutMs": 15000,
  "retryDelayMs": 1000,
  "renderMarginMs": 1000
}
```

`readySelector` must identify exactly one visible element. `readyText` is required to reduce empty-state/stale-heading false positives. `busySelector` is optional; omit it unless verified. Default fault is `rejection`. Add `null-result` only when recovery after a resolved null is an explicit requirement. An IPC rejection is not evidence that HTTP 503, connection failure and malformed JSON were independently tested.

The recovery deadline is measured from the injected result and calculated as `retryDelayMs + 2 * baselineReadMs + renderMarginMs`. `baselineReadMs` is the measured target handler duration. The deadline must be 200–60000ms. These timing assumptions remain explicit; one baseline is not a statistically reliable latency bound.

## 5. Run without interactive prompts

From the tools folder:

```bash
npx recovery-probe ipc --config ./ipc-scenario.json
```

A fresh private report directory is created automatically. Repeat the same command for another run. `--out NEW_DIRECTORY` chooses an explicit output folder. Reports include baseline invocation counts, real-handler timings, injected count, successful real calls after injection, dependency results, and cleanup. Files are `report.html`, `report.json`, `scenario.json`, plus a local ignore rule.

The checker:

1. Requires the hook to have captured all watched channels and identifies its selected window. A temporary nonce verifies that the CDP renderer and main-process hook refer to the same window, even if another running app has the same URL; the nonce is then removed.
2. Reloads the current route to clear renderer query cache and verifies real data, exactly one target invocation, and successful dependency reads.
3. Arms one fault with a unique ID and bounded TTL, then reloads.
4. Requires exactly one injection, a later successful real target call, successful dependencies and the same visible content expectation. Extra target calls are inconclusive because unrelated refetches could resemble recovery.
5. Resets the plan in `finally`, checks that it is disarmed, and performs a fresh healthy reload as cleanup. Cleanup never promotes an earlier failure to a pass.

The global main-process control exposes `identify()`, `begin(...)`, `snapshot()`, `reset(id)` and `dispose()` for local diagnostic use. Run IDs cannot be reused; a stale reset cannot disarm a newer run. Faults expire without CLI cleanup, and pending real calls block a new run rather than contaminate its observations.

## Result boundaries

- `RECOVERED`: the selected IPC recovery expectation passed.
- `RECOVERY_NOT_OBSERVED`: no verified recovery within the configured deadline; investigate against product expectations.
- `BASELINE_FAILED` / `BASELINE_AMBIGUOUS`: healthy setup or exactly-one-invocation assumption not established; no recovery verdict.
- `DEPENDENCY_FAILED` / `DEPENDENCY_NOT_READY`: a separate prerequisite failed or did not finish; not attributed to the selected recovery path.
- `FAULT_NOT_TRIGGERED`: the configured invocation did not consume exactly one fault.
- `TRAFFIC_AMBIGUOUS`: extra target traffic prevents identifying the expected single retry.
- `TARGET_NAVIGATED`: the selected renderer left the intended screen.
- `ENVIRONMENT_BLOCKED`: a sampled check found the renderer hidden or offline; retry may be paused.

Exit codes: 0 all checks plus cleanup passed; 1 an observed recovery failure; 2 setup/inconclusive. Sampling cannot prove that no very brief visibility transition occurred. A successful handler return also does not certify its response schema; the fixture content assertion remains necessary. In the default explicit verifier, two consecutive failures are not injected; exhausting a one-retry policy is a separate product expectation.

## Inspector reliability and uncertain replies

Preview.5 evaluates synchronous controls without `awaitPromise`. Window identification uses a retained remote Promise followed by `Runtime.awaitPromise`, then releases its object group. This avoids the observed Electron main-process `Promise was collected` failure for implicit awaiting of plain values.

A failed `begin` reply does not prove that arming failed. The checker records the ID before sending, attempts reset by that ID even on protocol errors, and independently reads back `armed: null`. It never retries begin or uses an unscoped reset to clear another run. If the inspector is unavailable or a plan remains armed, cleanup is unverified: stop the test app rather than continue. The hook's TTL remains a fallback, not a claim that cleanup succeeded. A protocol failure produces no application recovery verdict.

All reports remain local. No AI service or source upload is used. The app still contacts its configured backend on real calls. After testing, disable the development flags and revert only the hook changes introduced for this test, preserving pre-existing work.

## Experimental discovery (preview.6)

Use the same development-only hook and loopback ports described above, but **restart the app with the new hook module** after upgrading. Discovery checks the loaded hook's repeated-fault capability before injecting anything. Open the chosen read-only screen and keep the window visible and online.

```bash
npx recovery-probe ipc --discover --config ./ipc-files.json
```

The existing config is accepted. `readySelector`, `readyText`, `busySelector`, `faults`, `retryDelayMs` and `renderMarginMs` are ignored in discovery mode. It automatically runs exactly three experiments: one rejection, two consecutive rejections, and one null result. This is an explicit fault plan, not autonomous exploration. A minimal config is:

```json
{
  "channel": "fixture:read",
  "requiredChannels": ["fixture:versions"],
  "observationMs": 8000,
  "baselineTimeoutMs": 15000,
  "repeats": 3
}
```

Replace channels with the explicitly allowed read channels in your app. Dependencies must be listed: the tool cannot discover native/IPC semantics or infer that an operation is read-only. Defaults use CDP 9222 and inspector 9229. Three healthy reloads establish a stable text fingerprint; another healthy control precedes every faulted run. Default success-path workload is 22 reloads (3 baselines + 18 control/fault reloads + 1 cleanup). Failure observations can take several minutes in total. Observation windows are explicit budgets, not inferred guarantees about the app's retry policy.

Reports contain UI counts, English loading/empty/error/retry indicators, text hashes, call counters and timing samples. Raw UI text is used transiently but not saved; no response bodies, screenshots, credentials or source uploads are collected. A text hash is not guaranteed anonymization. Reports and scenario configs remain private local files ignored by git; discovery saves only its supported configuration fields, dropping ignored selectors/text. Channel names and port configuration still appear in the report.

- `RECOVERED`: a later real read succeeded and stable UI text matched its healthy control.
- `SILENT_EMPTY`: suspected failure-as-empty behaviour; review against product requirements. A legitimate empty healthy control does not trigger this lead.
- `UNCAUGHT_ERROR`: additional renderer exceptions; inspect locally for cause.
- `ERROR_OR_RETRY_SHOWN`: observed error/retry indication; no automatic bug claim.
- `LOADING_AT_DEADLINE` / `UI_DIFFERENCE_AT_DEADLINE`: product decision needed, not proof of permanent failure.
- `UNSTABLE`, `FAULT_NOT_TRIGGERED`, environment/dependency/control errors: inconclusive.

English heuristics can misinterpret unrelated text and miss translated or icon-only states. Discovery uses the first main landmark, or the body if absent, and stops if healthy text varies. Virtualization, clocks and live content may make this unsuitable; use the existing explicit `ipc` verifier then. No DOM snapshots or region-specific source semantics are inferred. Visibility changes remain blockers, not deliberate experiments.

Each finding includes counts of repeated outcomes, a suggested investigation and a replay instruction. Re-run the saved scenario with `ipc --discover --config PATH` after a local fix. Compare the same experiment and its healthy controls; disappearance of a heuristic alone does not prove a fix. There is no automatic patch application or `verify <id>` command in this preview.

Exit 0 means completed with only informational observations; exit 2 means findings need review or the experiment was inconclusive. Discovery never returns exit 1 for an unverified heuristic defect. The existing explicit checker retains its exit codes. `recoveryMs` measures injection-to-detection, including sampling and a 300ms UI stability requirement; it is not just the handler duration.
