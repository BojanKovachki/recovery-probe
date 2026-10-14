# Observe reads without resetting the app

Available in **0.3.0-preview.12**. Install the exact preview and verify the CLI:

```bash
npm install --save-dev --save-exact recovery-probe@0.3.0-preview.13 playwright@1.62.1
npx recovery-probe --version
```

Use observation when reloading would erase the state you are investigating: cached rows, content carried between screens, or content surviving a session change. The command attaches to an existing development browser/Electron renderer. It never reloads, navigates, clicks, changes focus, clears caches, injects faults, or resets the UI at the end. You operate the app yourself.

This is evidence collection, not an identity-isolation test. A cache hit can be correct. Content overlap can be legitimate shared data. No finding establishes whose data is visible or whether a server authorized it correctly.

## Configuration

Save a local JSON file, for example `observe.json`:

```json
{
  "transport": "ipc",
  "cdp": "http://127.0.0.1:9222",
  "inspector": "http://127.0.0.1:9229",
  "channel": "fixture:read-items",
  "regionSelector": "#items-panel",
  "contentSelector": "tbody tr[data-item]",
  "observationMs": 90000,
  "sampleMs": 100
}
```

IPC requires the [explicit development hook](ipc.md), loaded **from the same installed package version** before handler registration. It must advertise `observation` and `readTimestamps` capabilities. An old running hook is rejected before starting a plan; reinstalling the CLI alone does not update a hook already loaded in the app. Resolve the updated hook with `node -p "require.resolve('recovery-probe/ipc')"`, update the app's development hook path if needed, and restart the development app **before reproducing the cached state**. The selected window is verified against that hook without reloading it.

For renderer HTTP reads, use:

```json
{
  "transport": "http",
  "cdp": "http://127.0.0.1:9222",
  "page": 0,
  "endpoint": "http://localhost:3000/api/items",
  "regionSelector": "#items-panel",
  "contentSelector": "tbody tr[data-item]",
  "observationMs": 90000,
  "sampleMs": 100
}
```

Select an existing page using `desktop --list`. HTTP observes main-frame GET fetch/XHR requests grouped by origin/path. Query values, headers and bodies are not recorded. Native SDK traffic, IPC, service-worker-only traffic, iframes, and other endpoints are outside this HTTP observation. It does not install route interception, so it does not disable the browser's HTTP cache.

`regionSelector` must identify at most one region. The region may disappear or become hidden during navigation. `contentSelector` is a CSS selector **inside that region**, chosen to identify actual data rows/cards rather than headings, placeholders or loading skeletons. This explicit marker is the only basis for saying data-dependent content is present. Nothing infers a framework mount, a user id, or ownership from the DOM.

The duration is bounded to 500–120000 ms; sampling is bounded to 50–1000 ms. Default duration is 30000 ms and sampling is 100 ms. Setup, protocol operations and cleanup add overhead. An unresponsive UI sample times out after 5 seconds and produces incomplete evidence; Ctrl+C interrupts a pending UI sample. Only one target is counted per capture. Existing fault/discovery configs must be adapted: unrelated options are rejected to avoid silently performing a different experiment.

## Capture a return visit

```bash
npx recovery-probe observe --config observe.json
```

1. Start on a neutral screen and wait for the terminal's `Observing` message.
2. Open the data screen and let its read finish. Return to the neutral screen.
3. Press Enter in the terminal and wait for `New observation interval`. Open the data screen again.
4. Let capture finish, or press Ctrl+C to save partial evidence.

Enter starts an interval at the next sample boundary; it does not navigate or reset counters. Thus the second interval can show **zero new reads** while retaining the last observed read/completion time from the first interval. Up to 50 intervals are allowed. Terminal input is not saved as a label; do not type credentials. `--interactive` enables newline markers on piped stdin; without it, noninteractive runs have a single interval. `--json` writes the report to stdout and keeps progress on stderr.

To observe a particular cached state that already exists, start on a neutral screen immediately before returning to it. Reads before capture are unknown. Start earlier if you need a measured age of the last read.

## Report provenance and sampling

Since preview.13, `metadata` records the installed Recovery Probe version, CLI Node version, browser version when available, and the IPC hook's reported version, runtime and observation capabilities. Older observation-capable hooks remain compatible; unavailable metadata is null. Restart with the new hook if its version/runtime metadata is needed. No environment variables, account information, full user agent or registered-channel inventory is included.

`sampleMs` is the requested delay **after each completed sample**, not a guaranteed sampling resolution. `sampling.sampleDuration` summarizes the UI-read-to-counter-snapshot duration; `sampling.startToStart` measures actual cadence, including protocol work, delays and operator callbacks. Both contain count, meanMs, minMs and maxMs. All completed samples contribute, including unchanged samples omitted from the timeline. With no samples the duration statistics are null; with fewer than two samples cadence statistics are null. A timed-out/incomplete sample is not included. `captureComplete` retains its existing meaning and does not guarantee that brief UI flashes were captured.

JSON findings retain their codes/bases and add a plain-language `summary`. HTML shows first-content sample bounds relative to each interval rather than an exact paint time.

## Interpretation

Local `report.json` and `report.html` contain interval read counts, starts/completions, first-content sample bounds, and a change-only sampled timeline. `scenario.json` records the selected scope. No screenshots, response bodies or raw UI values are saved. Region text and repeated values are hashed; hashes are **not anonymization**, particularly for predictable text. Treat reports and selectors as private evidence.

`CONTENT_BEFORE_READ` means the configured content marker was sampled as visible with **no observed completion during that interval**. Its basis distinguishes zero observed starts from an outstanding read. This is an observation requiring interpretation, not a defect verdict. It may include content already present at the interval's first sample; that is recorded explicitly. A read begun in a previous interval is represented by `pendingAtStart`.

The observer brackets each UI sample with read snapshots. If a completion arrives during that sample, it does not claim content preceded that completion. Timestamps are epoch milliseconds from the observer/hook clock; ages are measured within the same clock. Pre-capture history and pre-capture pending work remain unknown. An HTTP success means a completed 2xx response, not JSON validation or application success. IPC completion means handler settlement, not renderer consumption.

This release has no automatic login steps, operator identity assertions, identity callback, ownership oracle, or `CROSS_IDENTITY_CONTENT` verdict. A separate account-switch experiment needs evidence about identity and expected data sharing. Reload-based recovery and refresh checks still reset renderer state and cannot establish session isolation.

Capture ends without touching UI state. HTTP listeners are detached; the owned IPC observation lease is ended with its run id. Faults cannot be included in an observation plan, and an active foreign plan is never replaced. An observation lease also expires if the client disappears. Calls already started may finish normally after capture.

A document reload/navigation ends capture as incomplete because the renderer state may have been reset; SPA navigation is allowed. Hidden-document samples and truncated regions are coverage gaps. Very short flashes between samples may be missed. If the content marker is never observed, `CONTENT_MARKER_NOT_OBSERVED` records the missing evidence; it may reflect an empty screen, an unvisited route, or a wrong selector. Exit `0` means the bounded capture completed without recorded coverage gaps; `2` means incomplete coverage or a setup/cleanup error; `130` means operator interruption. None means a recovery or security pass.

## Supported inspector API

Advanced scripts can use `recovery-probe/ipc-inspector` after installing preview.12, without importing private `src/` paths:

```js
import { randomUUID } from 'node:crypto';
import { connectIpcInspector } from 'recovery-probe/ipc-inspector';

const control = await connectIpcInspector('http://127.0.0.1:9229');
const id = randomUUID();
try {
  // Explicitly bounded, fault-free, and protected against replacing active plans.
  await control.call('begin', {
    id, channel: 'fixture:read-items', observation: true, ttlMs: 30000
  });
  // Operate the application in your own harness, then collect evidence.
  const snapshot = await control.call('snapshot');
  if (snapshot?.id !== id || !snapshot.observingUntil) throw Error('Observation coverage lost');
  console.log(snapshot.channels['fixture:read-items']);
} finally {
  try { await control.call('reset', id); }
  finally { control.close(); }
}
```

`callIpcInspector(send, method, argument)` is also exported for custom Node inspector transports. It accepts only the existing probe control method allowlist. The CLI additionally performs window matching and cleanup readback; advanced callers must implement those checks themselves. Never retry `begin` after an uncertain reply. Use the same id for cleanup; never use an unscoped reset against shared tooling.

Each channel snapshot adds `firstReadAt`, `lastReadAt`, `firstCompletedAt`, `lastCompletedAt`, and `lastSuccessAt` (null until observed). `startedAt` and `capturedAt` belong to the plan/snapshot. `observation: true` opts into the bounded fault-free lease; ordinary fault-free `begin` calls retain their existing recovery-control semantics.
