# Refresh experiments (preview.9)

Opt-in experiments on an already populated screen, using one explicitly named synthetic window event. The current implementation does **not** toggle connectivity, freeze pages, simulate OS sleep/resume, refresh tokens, invoke global functions or accelerate timers. An `online` event tests the event handler while `navigator.onLine` stays unchanged. Use an authorized development/testing session: handlers can cause writes or other side effects even though the selected fault target is a read.

## Configure and run

HTTP example for an attached browser/Electron renderer with GET fetch/XHR:

```json
{
  "transport": "http",
  "cdp": "http://127.0.0.1:9223",
  "pageUrl": "http://localhost:3000/items",
  "endpoint": "http://localhost:3000/api/items",
  "requiredEndpoints": [],
  "trigger": { "type": "dom-event", "target": "window", "name": "online" },
  "fault": "http-error",
  "times": 1,
  "repeats": 3,
  "baselineTimeoutMs": 15000,
  "observationMs": 15000,
  "idleMs": 1000,
  "settleMs": 800,
  "secondTrigger": false
}
```

IPC example, with the existing [dev-only registration hook](ipc.md) installed before handlers and the intended screen already open:

```json
{
  "transport": "ipc",
  "cdp": "http://127.0.0.1:9222",
  "inspector": "http://127.0.0.1:9229",
  "channel": "example:read",
  "requiredChannels": [],
  "trigger": { "type": "dom-event", "target": "window", "name": "online" },
  "fault": "rejection",
  "times": 1,
  "repeats": 3,
  "secondTrigger": true
}
```

Replace the example target with your allowed read. Known baseline dependencies belong in `requiredEndpoints`/`requiredChannels`. They must load in the healthy baseline; they do not all need to refresh on the event. No automatic source inspection or dependency discovery occurs. HTTP faults: `http-error` (503), `connection-failure`, `invalid-json`. IPC faults: `rejection`, `null-result`. `times` accepts 1–10; `repeats` accepts 1–3. Observation/baseline windows accept 500–30000 ms, idle 200–10000 ms, stability 100–5000 ms.

```bash
npx recovery-probe refresh --config ./refresh.json --out ./refresh-run1 --json
```

The output directory must be new. The command writes private `report.json`, `report.html`, and `scenario.json`; `--json` prints a compact summary and evidence path. `page` selects an HTTP target if needed, `regionSelector` optionally selects a unique comparison region, and `restoreWindow: true` opts into reversible un-minimizing. Keep windows uncovered. No new browser is launched; attachment leaves the app/browser running.

## Sequence

1. Calibrate three healthy reloads for the full `baselineTimeoutMs` window each. Require stable matching end states, a successful target read and successful required dependencies. An early stable intermediate screen is not accepted as the baseline. Later controls can finish early once they match this established baseline.
2. Before each experiment, reload a healthy screen, then observe an idle window. Target traffic in that window stops the run as attribution-ambiguous.
3. Dispatch the configured event with no fault. Require a target read and a stable healthy fingerprint; record the watched reads seen during this control. Legitimate changed content makes this strict comparison inconclusive, not a suspected defect.
4. Reload into the established healthy state and repeat the idle check.
5. Arm the chosen faults immediately before dispatching the event. Observe for the complete configured window without reloading or issuing another event.
6. Disarm and record spontaneous-phase observations. Optionally dispatch the same event again, fault-free, as a **separate second-trigger phase**. This never changes the spontaneous result.
7. Reset before subsequent experiments. Finally reload without faults and verify the healthy state.

Only configured reads are counted. A no-trigger quiet interval and repeated healthy controls reduce ambiguity, but **timing is association, not proof of causation**. An unrelated request starting only after the event cannot always be distinguished. This is explicitly recorded in each result. Multiplexed IPC arguments are not identified. This mode does not infer periodic schedules or simulate long offline periods.

## Results

| Classification | Meaning |
| --- | --- |
| `CONTENT_LOSS_ON_REFRESH` | Fully consumed fault plan followed by structural content loss; suspected defect requiring review. |
| `RECOVERED_AUTOMATICALLY` | A later real successful read and the baseline screen were observed without a second tool event. |
| `CONTENT_KEPT` | Final fingerprint matches the baseline; inspect `freshReadSucceeded` and indicators separately. It does not prove fresh data or retry success. |
| `UI_DIFFERENCE_AT_DEADLINE` | A difference needing review, without enough evidence for structural-loss classification. |
| `TRIGGER_NO_READ` | No target read in the healthy trigger control, or no verified injection in the faulted phase; inconclusive. |
| `FAULT_NOT_TRIGGERED` | Fewer faults consumed than requested; inconclusive, no second-trigger experiment. |
| `EXPERIMENT_CONFOUNDED` | Real request/dependency failures or new renderer errors prevent the intended isolated comparison. |
| `INCOMPLETE_EXPERIMENT` | The requested repetitions did not all complete consistently. |

`noSubsequentReadObserved` is a bounded observation, not a bug verdict. The summary names the synthetic event and time window; it never claims real network restoration or permanent non-recovery. Optional second-trigger results are `RECOVERED_AFTER_TRIGGER`, `NO_REFRESH_SUCCESS_OBSERVED`, or `NOT_RECOVERED_WITHIN_WINDOW`. They are explicitly tool-induced, not spontaneous healing.

The report retains healthy-control timing/timelines, fault counters, before/after structural summaries, indicators, and subsequent-read counts. `repeatConsistent` includes repeated inconclusive outcomes; `repeatConfirmed` excludes inconclusive outcomes and requires three completed agreeing runs. `ok`/exit 0 means informational observations and verified cleanup, not proof of application correctness. Exit 2 means review needed or inconclusive. There is no heuristic exit-1 verified-bug verdict.

## Cleanup and limits

Own HTTP routes are removed; IPC plans use scoped verified reset and bounded TTL. Ctrl+C/SIGTERM requests cooperative cancellation followed by disarm and cleanup. Abrupt termination, a hung target or loss of control connectivity can prevent cleanup: restart the test app if cleanup is unverified. Network and page lifecycle settings are never changed by this mode. No process can guarantee cleanup after an uncatchable kill.

HTTP controls use the selected origin/path across query variants; IPC controls use the allowed main-frame sender/channel. Neither tests native transport failures. Initial baseline completeness, changing live data, hidden windows and unknown dependencies remain limitations. No mobile WebView compatibility claim is made without testing. Saved endpoint paths, channels and event names may be private; UI text/payloads are not saved, and hashed summaries are not anonymization.

## Initial readiness (preview.10)

Calibration adds three full bounded observation windows before injection. It compares end states without preferring nonempty screens or higher item counts: legitimate empty results remain valid. Each baseline retains elapsed time and its bounded timeline. A mismatch or unsettled final state stops the experiment before injection. No baseline is trusted until all three agree, so an unsuccessful calibration cannot claim verified final UI restoration; fault reset is reported separately. Content arriving after the window and unknown dependencies remain limitations. This generic policy is shared by HTTP and IPC refresh experiments; initial-load discovery is unchanged.
