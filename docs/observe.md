# Observe reads without resetting the app

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

Select an existing page using `windows`. HTTP observes main-frame GET fetch/XHR requests grouped by origin/path. Query values, headers and bodies are not recorded. Native SDK traffic, IPC, service-worker-only traffic, iframes, and other endpoints are outside this HTTP observation. It does not install route interception, so it does not disable the browser's HTTP cache.

`regionSelector` must identify at most one region. The region may disappear or become hidden during navigation. `contentSelector` is a CSS selector **inside that region**, chosen to identify actual data rows/cards rather than headings, placeholders or loading skeletons. This explicit marker is the only basis for saying data-dependent content is present. Nothing infers a framework mount, a user id, or ownership from the DOM.

`detail` defaults to `"content"`: each sample reads visible selected markers and their normalized text, without traversing the region's full structure, controls and repeated-value distributions. Set `"detail": "region"` to retain detailed region diagnostics alongside the same marker evidence. Fault-injection/discovery workflows retain their detailed inspections.

`ui.contentCount` counts visible matches of your content selector. In region detail, `ui.items` is a separate generic list/row heuristic and is **not** the number of application records. Content fingerprints cover ordered normalized marker text/count, not attributes, image pixels, input values, server data or account identity. Controls inside a selected marker contribute to its text; use a narrower marker when appropriate.

Marker inspection is capped at the first 1000 selector matches and 200000 normalized text characters per sample. Exceeding either sets `ui.content.truncated` and a coverage gap; counts may then be partial and comparisons are unavailable. These caps limit collected evidence, not a guarantee about browser execution time. CSS matching and reading a large individual element still cost work.

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

`metadata` records the installed Recovery Probe version, CLI Node version, browser version when available, and the IPC hook's reported version, runtime and observation capabilities. Metadata an older hook doesn't report is null. No environment variables, account information, full user agent or registered-channel inventory is included.

`sampleMs` is the requested delay **after each completed sample**, not a guaranteed sampling resolution. `sampling.sampleDuration` summarizes the UI-read-to-counter-snapshot duration; `sampling.startToStart` measures actual cadence, including protocol work, delays and operator callbacks. Both contain count, meanMs, minMs and maxMs. All completed samples contribute, including unchanged samples omitted from the timeline. With no samples the duration statistics are null; with fewer than two samples cadence statistics are null. A timed-out/incomplete sample is not included. `captureComplete` retains its existing meaning and does not guarantee that brief UI flashes were captured.

JSON findings retain their codes/bases and add a plain-language `summary`. HTML shows first-content sample bounds relative to each interval rather than an exact paint time.

`sampling.phases` summarizes `beforeSnapshotMs`, `uiRoundTripMs`, `rendererReadMs`, `summarizeMs`, and `afterSnapshotMs`. Renderer time is measured inside the page; the other durations use the CLI's monotonic clock. **Renderer time is included in the UI round trip**, so these fields must not all be added together. They help distinguish renderer work from protocol/serialization and counter costs. Timing values are excluded from the UI signature, so timing noise does not fill the change-only timeline. An observation lease, inspector transport or busy app can still dominate cadence.

For a reproducible local diagnostic from a repository checkout, run `npm run benchmark:observe` after installing dependencies and Chromium. It alternates content/region reads of a synthetic 200-row fixture, discards warmup samples, and prints renderer, round-trip, summarization and transfer measurements. This is not a performance pass/fail gate or a guarantee of detecting a particular flash duration. Compare actual cadence in field reports before drawing conclusions about the application under test.

## Content comparisons

`comparisons` and the HTML/terminal summaries make two relationships explicit:

- `INTERVAL_RETURN`: compare the first visible selected content in a new operator interval with the last visible selected content from an earlier interval. Read counts explain whether new selected calls started in the current interval. An interval is not a verified route, mount or identity transition.
- `READ_COMPLETION`: compare a sample before observed completion(s) with the first subsequent sample whose before/after counters agree on the number of completions. A completion during a UI read is ambiguous: comparison waits for a later sample. Successful and failed completion counts are reported separately; overlapping completions may be grouped.

Results are `unchanged`, `changed`, or `unavailable`. Unavailable means the required visible, untruncated marker summaries are missing. An unchanged result means only that the sampled ordered marker text and count match. It does not prove that content stayed continuously visible, that the data is fresh, or that the renderer has consumed a completed read. A delayed render may change in later timeline entries. There is no comparison when a suitable pre-completion sample was not captured; an unresolved completion at capture end cannot establish a post-completion comparison. Up to 1000 comparisons are retained; exceeding that records a coverage gap.

The browser tests include unchanged content after a failed refresh, changed content after a successful refresh, cached interval return, a sampled 250 ms pulse, and a pulse entirely between samples that remains undetected. These controls deliberately distinguish captured evidence from missed transitions.

### Later samples after a comparison

Each retained comparison also has `followUp` evidence from later completed samples in the **same operator interval**. The original `result`, `before` and `after` remain unchanged. Follow-up compares with the original `before` baseline, not the first return sample:

- `samples`, `comparableSamples` and `unavailableSamples` count later samples, including unchanged samples omitted from the timeline.
- `firstBaselineMatch` records the first later sample matching the baseline, or null. It records an observation, not an exact transition time.
- `latest` records the last follow-up sample, its bounds and its comparison result. Absent/hidden or truncated evidence is unavailable; it cannot establish a match.
- `summary` appears in JSON, terminal and HTML output. For a 19 → 17 → 19 marker sequence it says that content initially differed and a later sample matched. If content diverges again, the latest comparison says changed. With no later sample, that absence is explicit.

Tracking ends at the next operator interval or capture termination, including interruption. These are sampled comparisons, not a settling rule, continuous-visibility claim, identity assertion or recovery verdict. Read completions and later UI changes are not proof of causality. The existing 1000-comparison cap also bounds follow-up tracking.

## Actions, tracked rows and delayed UI updates

The development IPC hook must come from the same version as the CLI; restart the app after upgrading.

These options are opt-in and extend the same fault-free capture. They answer "how long after the user's action did the screen show the right state, and did data arrive before it?"

```json
{
  "transport": "ipc",
  "channel": "app:invoke",
  "methods": ["queue.read"],
  "dataEvents": { "channel": "app:event", "methods": ["queue.changed"] },
  "regionSelector": "#queue",
  "contentSelector": { "css": "button.item-action", "text": "Move up" },
  "rows": {
    "selector": "li[data-item]",
    "key": ".item-name",
    "state": { "css": "button.item-action", "role": "button" },
    "states": ["Pause", "Move up", "Resume"],
    "aliases": { "second": "Exact name of the second item" }
  },
  "actions": [{ "name": "start", "selector": { "role": "button", "name": "Start" } }],
  "lagThresholdMs": 2000,
  "minUnchangedReads": 2,
  "observationMs": 45000
}
```

### Selectors

`contentSelector`, `rows.selector`, `rows.key`, `rows.state` and action selectors accept a CSS string or `{ "css", "role", "name", "text" }`. `role` matches an explicit `role` attribute or the element's implicit role (button, link, row, cell, listitem, heading and similar). `name` matches the accessible name approximated as `aria-label`, `aria-labelledby` text, visible text, `title` or `alt`. `text` matches the element's normalized visible text exactly. `name` requires `role`. These literal values stay in the private `scenario.json`; the report never copies them.

### Actions

`actions` records clicks on configured elements during the capture: the configured action name, the time, and whether the browser marked the event as real user input (`trusted`). No other event data is stored. A click on a label counts once, although the browser also clicks the label's control. Each report action lists the tracked rows that appeared or changed afterwards, relative to the action (`actionEffects`). Times come from the page and observer wall clocks on the same machine.

### Tracked rows

`rows` follows each visible row in the region. The row key text is hashed (`key:` plus 16 hex characters) unless it exactly matches a configured alias, so the report can say "row ‘second’" without storing its text. The state element's text is recorded only if it is in the `states` allowlist; other text becomes `other`, and a missing state element becomes `none`. States shown by an icon can be named with [markers](#state-markers-and-unexpected_row_state). Row identity is only as stable as the key text you select: choose a name, not a progress value.

### Shared IPC channels and data events

When one IPC channel carries many kinds of calls (for example an SDK bridge), counting every call makes read evidence meaningless. Give the development hook a `classify(channel, args)` function that returns a short method label (`/^[\w.:/-]{1,100}$/`); the hook counts calls per label and never stores arguments. A classifier error or invalid label counts as `unclassified` and never affects the real call. Then select the read methods with `methods`.

Main-to-renderer pushes can be observed as data-change events. List their channels in the hook's `pushChannels`, optionally with `classifyPush(channel, args)`, and select them with `dataEvents`. The hook wraps `send` on the target window's WebContents only while an observation lease is active, counts sends and their times, never stores payloads, and removes the wrapper at the end of the lease. Fault plans never observe pushes.

These counts cover calls through `webContents.send` only. Calls through `webContents.mainFrame.send`, `postMessage`, other frames, or a reference to `send` saved before the wrapper was installed are not counted. A zero push count does not prove that no message was sent through those paths.

```js
installIpcProbe(ipcMain, {
  enabled: true, channels: ['app:invoke'], sender: () => mainWindow?.webContents,
  classify: (_channel, [payload]) => methodNameOf(payload),       // your app-specific, development-only code
  pushChannels: ['app:event'], classifyPush: (_channel, [payload]) => eventNameOf(payload),
});
```

### `DELAYED_UI_UPDATE`

Reported when a tracked row kept an allowlisted state across at least `minUnchangedReads` completed selected reads and for at least `lagThresholdMs`, and then changed to another allowlisted state without a data event in the sampled change window. With `dataEvents` configured, the last data event must also be at least `lagThresholdMs` older than the change (basis `NO_DATA_EVENT_BEFORE_UI_CHANGE`). Without data events the basis is `UNCHANGED_ACROSS_READS`, because a later read could have carried the change. Confidence is medium only when data events are configured and the persisted state began within `lagThresholdMs` of a recorded action, the typical shape of optimistic UI state that outlives the real state; everything else is a low-confidence lead. A state driven by reads you did not select (for example per-item status calls) can also produce a low-confidence lead. The finding records the row, both states, how long the earlier state persisted, the completed reads and data events while it persisted, and the time since the last related action.

This is a lead, not a verdict. Read contents are never recorded, so the tool cannot prove that the data said the new state earlier. Typical causes are optimistic UI state that outlives the real state, timers, or render paths that ignore fresh data. Changes are only evaluated between consecutive samples of a visible row.

### State markers and `UNEXPECTED_ROW_STATE`

Some screens show a row's state with an icon or badge rather than text. `rows.markers` names such states: each label (other than `none` and `other`) maps to a selector inside the row, and a row's state is the label of the first marker with a visible match. Rows without a matching marker fall back to the `state` text, or `none`. Marker labels count as tracked states, so they appear in transitions, action effects and `DELAYED_UI_UPDATE` like text states. `state` and `states` become optional when `markers` is set.

`rows.unexpected` lists states, from `states` or `markers`, that the region must never show. Use it for views that filter rows, such as an "installed" list that must not show items still downloading:

```json
{
  "regionSelector": "#library:has(.installed-only:checked)",
  "contentSelector": ".card",
  "rows": {
    "selector": ".card",
    "key": ".card-title",
    "markers": { "not installed": ".card-title ~ svg.download-icon" },
    "unexpected": ["not installed"]
  }
}
```

Each stretch of consecutive samples in which a row shows an unexpected state adds one `UNEXPECTED_ROW_STATE` finding; a row that leaves the region or shows another state ends the stretch. It records the row, the state, the bounds of the first sample, the end of the last sample, the number of samples, and the last configured action before it. For example: "Row ‘queued’ showed not installed, which this region must not show, in 40 samples from 1.2–1.3 s to 6.0 s; first seen 0.1–0.2 s after action ‘show-installed’." The rule comes from your configuration, so check that it holds for every row the region can show. A state shown only between samples can be missed.

### Busy targets

If the selected target completes more than two reads per sample on average, per-completion comparisons cannot attribute UI changes. They are omitted and the report adds a `READ_COMPLETION_COMPARISONS_OMITTED` note; select `methods` to narrow the target. The terminal prints one comparison line per interval instead of one per comparison.

### Scripted steps (`--steps`)

`observe --config FILE --steps steps.json` runs an explicit operator script during the capture. Steps act on the app, so use them only with a test account and data you may change.

```json
[
  { "click": { "role": "button", "name": "Start A" } },
  { "wait": 1000 },
  { "mark": true },
  { "click": { "role": "button", "name": "Start B" }, "name": "start-second" },
  { "waitFor": "li[data-item]", "timeoutMs": 5000 },
  { "navigate": "#/queue" },
  { "wait": 12000 }
]
```

Each step has exactly one of `mark` (start a new interval and wait for it), `navigate` (same-document `#fragment` only; a document load would reset the state under observation), `click` (exactly one visible match, real input events through Playwright), `waitFor` (first visible match), `expect` (see below) or `wait` (milliseconds). `name` and `timeoutMs` are optional. Steps start once the capture is observing, run in order, and stop when the capture ends. A failed or unfinished script is reported in `operator` and adds the `OPERATOR_STEPS_INCOMPLETE` coverage gap. The validated steps are saved as a private `steps.json` next to the report. Without `--steps`, observation still never acts.

`expect` waits like `waitFor` (15 s unless `timeoutMs` says otherwise), but what it checks is the app: when nothing matching is visible in time, the step is `unmet`, the script goes on, and the report gets an `EXPECTATION_NOT_MET` finding naming the step, not the selector. Use it for what the app must show after a fault, such as a message or a retry button:

```json
{ "expect": { "role": "alert" }, "name": "repair-message", "timeoutMs": 10000 }
```

### Network steps

With `--network URL`, steps can also take hosts away from the app's own HTTPS connections through a running [`recovery-probe net`](net.md). Use them when the app's data comes through native code, such as an SDK in the main process. Start `recovery-probe net` without `--rules` first, start the app with its `HTTPS_PROXY`, then pass its URL to `--network`.

```json
[
  { "mark": true },
  {
    "network": { "host": "api.example.com", "fault": "stall", "dropOpen": true }
  },
  { "wait": 20000 },
  { "mark": true },
  { "network": "restore" },
  { "wait": 20000 },
  { "mark": true }
]
```

`network` takes one rule or a list, with the fields of [network rules](net.md#rules); their windows count from the step, and each set replaces the previous one. `"restore"` removes the faults. The capture also removes them when it ends, even after a failure. Compare the intervals as usual: what the screen kept or lost while the host was away, and whether it came back after the restore.

The report's mode becomes `observation with network faults`, and `network` lists what each step's rules faulted. A rule that faulted no connection adds `NETWORK_FAULT_NOT_TRIGGERED`. Faults that could not be removed add `NETWORK_FAULTS_NOT_RESTORED`; stop `recovery-probe net` to restore the app's network.

### Local files

A failed read can cost more than a blank screen: an app that treats an unknown file list as an empty one deletes the content it has installed. `--files DIR` takes a snapshot of the regular files under a directory (their paths and sizes, never their contents) when the capture starts, at each new interval, and when it ends, and compares each interval's snapshots.

- `files` in the report counts, per interval, the files removed, shrunk, added and grown, and the bytes the removed and shrunk files no longer hold.
- An interval that lost files gets `LOCAL_FILES_REMOVED`. It is a lead, not a verdict: a legitimate update also removes files. Mark an interval around the step you suspect, such as a network fault, to see where the loss happened.
- The removed and shrunk paths (up to 200 of each per interval) are kept only in a private `files.json` next to the report.
- Snapshots are compared per interval: a file removed and restored within one interval is not seen. They stop at 50,000 files and do not follow symbolic links. A partial or unreadable snapshot adds the `FILE_SNAPSHOT_INCOMPLETE` coverage gap.

### File steps

With `--files DIR`, steps can also damage a file under that directory, the way an interrupted download, a disk cleanup or an antivirus quarantine does, and the capture shows what the app did about it: whether it noticed, what it showed, and whether it put the file back.

```json
[
  { "mark": true },
  { "file": { "path": "Binaries/Win64/api.dll", "fault": "remove" } },
  { "click": { "role": "button", "name": "Play" } },
  { "expect": { "role": "alertdialog" }, "name": "repair-message" },
  { "wait": 60000 }
]
```

- `path` is relative to `--files DIR` and cannot leave it. `fault` is `remove`, `truncate` (cut to half its size) or `corrupt` (4 KB in the middle changed, the size kept). A step fails if there is no regular file there, or if an earlier step damaged it.
- The original is copied to a private temporary folder first. When the capture ends, after its last snapshot, each file is checked: `repaired` (the app put the original content back), `damaged` (still as the step left it) or `changed` (the app wrote something else, or removed it, such as a download still in progress).
- A file that is not `repaired` adds `LOCAL_FILE_NOT_REPAIRED` in the interval of its step. It is a lead: an app may repair only on its next start, so capture long enough for what you expect.
- A file left damaged or missing is put back from its copy; one the app rewrote is left as the app has it. A file that cannot be checked or put back, for example because the app still holds it open, adds the `FILE_FAULTS_NOT_RESTORED` coverage gap. The report gets only the error code, such as `EBUSY`; `files.json` names the kept copy and gives the full error.
- The report's mode becomes `observation with file faults`, and `fileFaults` lists each step's fault and outcome. Paths stay in the private `files.json`, and damaged files are left out of the snapshot comparison, so the step's own damage is not reported as `LOCAL_FILES_REMOVED`.

## Interpretation

Local `report.json` and `report.html` contain interval read counts, starts/completions, first-content sample bounds, and a change-only sampled timeline. `scenario.json` records the selected scope. No screenshots, response bodies, IPC arguments, push payloads or raw UI values are saved; tracked row keys are hashed and row states are kept only when allowlisted. Region text and repeated values are hashed; hashes are **not anonymization**, particularly for predictable text. Treat reports and selectors as private evidence.

`CONTENT_BEFORE_READ` means the configured content marker was sampled as visible with **no observed completion during that interval**. Its basis distinguishes zero observed starts from an outstanding read. This is an observation requiring interpretation, not a defect verdict. It may include content already present at the interval's first sample; that is recorded explicitly. A read begun in a previous interval is represented by `pendingAtStart`.

The observer brackets each UI sample with read snapshots. If a completion arrives during that sample, it does not claim content preceded that completion. Timestamps are epoch milliseconds from the observer/hook clock; ages are measured within the same clock. Pre-capture history and pre-capture pending work remain unknown. An HTTP success means a completed 2xx response, not JSON validation or application success. IPC completion means handler settlement, not renderer consumption.

This release has no automatic login steps, operator identity assertions, identity callback, ownership oracle, or `CROSS_IDENTITY_CONTENT` verdict. A separate account-switch experiment needs evidence about identity and expected data sharing. Reload-based recovery and refresh checks still reset renderer state and cannot establish session isolation.

Capture ends without touching UI state. HTTP listeners are detached; the owned IPC observation lease is ended with its run id. Faults cannot be included in an observation plan, and an active foreign plan is never replaced. An observation lease also expires if the client disappears. Calls already started may finish normally after capture.

`snapshot` remains the last observation snapshot, explicitly labelled `snapshotStage: "before-cleanup"`. `cleanupEvidence` separately records HTTP listener detachment or the verified IPC readback (owned run id, capture time, expired/cleared observation lease, no armed fault and zero injections). A pre-cleanup snapshot with an active lease does not contradict successful cleanup. Failed cleanup remains incomplete; setup failures may have no cleanup evidence.

A document reload/navigation ends capture as incomplete because the renderer state may have been reset; SPA navigation is allowed. Hidden-document samples and truncated regions are coverage gaps. Very short flashes between samples may be missed. If the content marker is never observed, `CONTENT_MARKER_NOT_OBSERVED` records the missing evidence; it may reflect an empty screen, an unvisited route, or a wrong selector. Exit `0` means the bounded capture completed without recorded coverage gaps; `2` means incomplete coverage or a setup/cleanup error; `130` means operator interruption. None means a recovery or security pass.

## Supported inspector API

Advanced scripts can use `recovery-probe/ipc-inspector` without importing internal file paths:

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
