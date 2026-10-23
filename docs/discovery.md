# Discovery

Discovery fails the read behind a screen in a few fixed ways and compares the screen with a healthy run each time. You don't write a ready selector or expected text: it learns what the healthy screen looks like first.

It works over IPC in an Electron app and over HTTP in a browser or an Electron renderer:

```bash
npx recovery-probe ipc --discover --config ./discover.json
npx recovery-probe web --attach --discover --config ./discover.json --cdp http://127.0.0.1:9222
```

For IPC, set up the hook and debugging ports first, as in [IPC](ipc.md). For HTTP, start the app or browser with a local debugging port, as in [Desktop and browsers](desktop.md).

## Configuration

IPC:

```json
{
  "channel": "files:read",
  "requiredChannels": ["files:versions"]
}
```

HTTP:

```json
{
  "endpoint": "http://localhost:3000/api/items",
  "pageUrl": "http://localhost:3000/items",
  "requiredEndpoints": []
}
```

The target is one read: an IPC channel, or the origin and path of a GET fetch/XHR in the main frame (query variants count as the same read). List the other reads the screen needs in `requiredChannels` or `requiredEndpoints`. Discovery can't find them on its own, and it doesn't wait for reads it doesn't watch.

| Option | Default | Meaning |
| --- | --- | --- |
| `baselineTimeoutMs` | 15000 | How long each healthy calibration load is watched. |
| `observationMs` (IPC), `recoveryTimeoutMs` (HTTP) | 8000 | How long a faulted load is watched after the first fault. |
| `settleMs` | 800 | How long the screen must stay unchanged to count as settled. |
| `repeats` | 3 | Runs per experiment, 1–3. |
| `faults`, `times` (HTTP) | all three, 2 | Which faults to inject and how many in a row. |
| `regionSelector` | first `main`, or `body` | The part of the screen to compare. |
| `cdp`, `inspector` | ports 9222 and 9229 | Where to attach. |

Other check options, such as `readySelector`, are ignored, and they are left out of the saved `scenario.json`.

## How a run goes

1. **Calibration.** Three healthy reloads, each watched for the whole `baselineTimeoutMs`. They must end on the same screen, or the run stops before any fault. An empty screen is fine if the reads behind it succeeded.
2. **Experiments.** Every faulted reload follows a healthy reload that must match the calibrated screen. If one doesn't, the run stops with `CONTROL_UNSTABLE` and keeps that control in `failedControl`.
3. **Cleanup.** The faults are removed, and a last healthy reload must match the calibrated screen (`finalReset: healthy`).

A load counts as settled when the target and its dependencies read successfully, no watched read is pending, no loading indicator shows, and the screen hasn't changed for `settleMs`. A faulted load must also use up every planned fault and get a real successful read after it before it counts as recovered.

With the defaults, a run takes at least 22 reloads and a few minutes.

## Experiments

| Over | Experiments |
| --- | --- |
| IPC | one rejection, two rejections in a row, one successful `null` result |
| HTTP | each fault in `faults` (`http-error`, `connection-failure`, `invalid-json`), `times` in a row |

Calibration also counts how often each healthy load reads the target (`readiness.callsPerLoad`). When every load reads it the same number of times, and more than once, discovery also fails the 2nd, 3rd and 4th call on its own: one rejection over IPC, the first listed fault over HTTP. Those findings have ids like `rejection-1-call2`. This catches a screen that ignores a failed prefetch but shows a failed second read as an empty list. When later calls aren't tried, `readiness.callsGap` says why: the counts differ between loads, a load reads more than four times, or the app runs an older IPC hook.

## Findings

| Classification | Kind | What happened |
| --- | --- | --- |
| `RECOVERED` | observation | A real read succeeded after the fault and the screen matched its healthy control. |
| `ERROR_OR_RETRY_SHOWN` | observation | The screen showed an error or a Retry button. |
| `SILENT_EMPTY` | suspected defect | The healthy screen had content; after the fault it said it's empty, with no error. |
| `CONTENT_LOSS` | suspected defect | Content disappeared without an error. |
| `UNCAUGHT_ERROR` | suspected defect | The renderer threw. |
| `LOADING_AT_DEADLINE`, `UI_DIFFERENCE_AT_DEADLINE` | decision needed | Still loading, or different, when the window ended. Not proof it never recovers. |
| `FAULT_NOT_TRIGGERED`, `UNSTABLE` | inconclusive | The fault didn't fire as planned, or the repeats disagreed. |
| `INCOMPLETE_EXPERIMENT` | inconclusive | The run stopped partway; `completedRuns` of `plannedRuns` are kept as partial evidence. |

A suspected defect is a lead, not a verdict: check it against what the screen should do. Errors, empty states and Retry buttons are recognised from English and German wording and from alert roles. Other languages and icon-only states without a role can be misread.

## Reports

Each run writes `report.html`, `report.json` and `scenario.json` to a new folder under `.recovery-probe/` (or `--out`). The HTML report starts with the findings table. Reports hold counts, structural summaries, timings and hashes of screen text, never the text, payloads or credentials. A hash isn't anonymization, and channel names and paths can still be private.

`--screenshots` also saves the screen after the first healthy baseline and after each faulted run, and shows them in `report.html`. They can show private data.

Exit code 0 means only observations and a healthy cleanup. 2 means findings to review or an inconclusive run. Discovery never exits with 1, because its findings aren't verified failures.

Rerun the saved scenario after a fix with the same command and `--config <report>/scenario.json`, and compare the same experiment, see [Before and after](compare.md). A finding that goes away isn't proof of a fix on its own.

## Window

Keep the window visible and uncovered. A hidden or offline window stops the run with `ENVIRONMENT_BLOCKED`. `--restore-window` un-minimizes it for the run and minimizes it again at the end.

## Limits

- It tests the first load of a screen. For a screen that's already loaded, see [Refresh](refresh.md).
- Unlisted dependencies, content that arrives after the calibration window, and live data can make the baseline incomplete or unstable.
- A structural difference isn't proof of a defect, and the observation window isn't proof that the screen never recovers.
- Only selected GET reads are faulted over HTTP. Native, service-worker and unwatched traffic isn't covered.
