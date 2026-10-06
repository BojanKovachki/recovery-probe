# IPC renderer recovery preview

This adapter is in `0.3.0-preview.4` on GitHub, not yet published to npm. It tests renderer recovery after **one rejected IPC invocation**, or optionally **one successful null result**. It does not simulate HTTP status codes, Rust transport failures, token refresh, connection banners or native retry behavior. Use only read-only channels in a development build with known fixture data.

Unlike renderer HTTP routing, this boundary requires a small main-process hook. The local agent can perform the setup below; no interactive picker is required. Do not edit generated client files or access Electron's private handler map.

## 1. Install in a separate tools folder

Node 22+ is required for the CLI. Electron 29's bundled Node can load the small CommonJS hook; it does not load Playwright into your main process.

```bash
mkdir -p recovery-probe-tools && cd recovery-probe-tools
npm install --save-dev github:BojanKovachki/recovery-probe#feat/ipc-recovery playwright@1.62.1
node -p "require.resolve('recovery-probe/ipc')"
```

Pin the tested commit for reproducible installs. Record the absolute path printed by the last command. After npm publication, use `recovery-probe@0.3.0-preview.4` instead of the GitHub reference. Chromium need not be downloaded: the checker attaches to Electron.

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

The local agent should derive this configuration from the real handler names, retry policy and DOM. It should not guess the spinner selector or choose a row that virtualization hides. A fixture account with one known file provides a stable assertion.

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

Exit codes: 0 all checks plus cleanup passed; 1 an observed recovery failure; 2 setup/inconclusive. Sampling cannot prove that no very brief visibility transition occurred. A successful handler return also does not certify its response schema; the fixture content assertion remains necessary. Two consecutive failures are deliberately not injected; exhausting a one-retry policy is a separate product expectation.

All reports remain local. No AI service or source upload is used. The app still contacts its configured backend on real calls. After testing, disable the development flags and revert only the hook changes introduced for this test, preserving pre-existing work.
