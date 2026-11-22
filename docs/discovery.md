# Discovery

Discovery fails the read behind a screen in a few fixed ways, and finally on every attempt, and compares the screen with a healthy run each time. You don't write a ready selector or expected text: it learns what the healthy screen looks like first.

It works over IPC in an Electron app, when the config names a `channel`, and over HTTP in a browser or an Electron renderer, when it names an `endpoint`:

```bash
npx recovery-probe discover --config ./discover.json
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
| `maxDurationMs` | none | The longest the whole run may take, cleanup included: 10000–86400000. See [Time limit and progress](#time-limit-and-progress). |

Other check options, such as `readySelector`, are ignored, and they are left out of the saved `scenario.json`.

## How a run goes

1. **Calibration.** Three healthy reloads, each watched for the whole `baselineTimeoutMs`. A load that doesn't settle stops the run with `BASELINE_NOT_HEALTHY`, and loads that end on different screens stop it with `BASELINE_UNSTABLE`, both before any fault. `BASELINE_UNSTABLE` usually means the screen changes on its own; use the explicit check for it instead. An empty screen is fine if the reads behind it succeeded.
2. **Screen check.** One reload with every read of the target failing: up to 10 in a row, of the first experiment's fault. If the screen still ends up exactly as the healthy one, the run stops with `FAULT_NOT_VISIBLE`, because no experiment on it would mean anything. Usually the screen doesn't show what that read loads (for example, the app is on another screen than intended), or it shows the same either way: an empty list, or content from a cache. Open the screen that uses the read, with data on it. If the app reads the target more than 10 times and a later read succeeds, the check can't tell, and the run goes on. If the app leaves the page during the check, that counts as a change; discovery returns to the page and goes on. `screenCheck` in the report records the outcome: `changed`, `unchanged` or `not-established`.
3. **Experiments.** Every faulted reload follows a healthy reload that must match the calibrated screen. If one doesn't, the run stops with `CONTROL_UNSTABLE` and keeps that control in `failedControl`.
4. **Cleanup.** The faults are removed, and a last healthy reload must match the calibrated screen (`finalReset: healthy`).

A load counts as settled when the target and its dependencies read successfully, no watched read is pending, no loading indicator shows, and the screen hasn't changed for `settleMs`. A faulted load must also use up every planned fault and get a real successful read after it before it counts as recovered.

With the defaults, a run takes at least 29 reloads and a few minutes. It says how long it can take when it starts.

## Time limit and progress

When a run starts, it prints on stderr how many reloads it plans and the longest it can take, and records both in the report's `estimate`:
- `plannedLoads`;
- `worstCaseMs`, from the configured windows;
- `exact`, which turns true once calibration has counted the reads of a load and the later-call experiments are known.

Each healthy load counts as `baselineTimeoutMs` plus 2 s, and each faulted one as `observationMs` (`recoveryTimeoutMs` over HTTP) more. Real runs are usually much shorter.

### `maxDurationMs`

`maxDurationMs` limits the whole run, cleanup included. Without it, a run takes as long as its steps do.

- **Time is kept back for cleanup:** one healthy reload's worst case plus 5 s. It shows in the report as `budget.cleanupReserveMs`.
- **Nothing starts that can't fit.** Before calibration and before each experiment, the run checks that the step's worst case fits in the time left before that reserve.
- **A step that runs over is stopped.** A reload never waits past the limit, and a load still running when the limit arrives stops.
- **When the time is up,** the run goes straight to cleanup, and the report says how far it got:
  - `stoppedReason` and `error` are `BUDGET_EXHAUSTED`;
  - completed experiments keep their findings;
  - an experiment stopped partway becomes `INCOMPLETE_EXPERIMENT` with its completed runs;
  - `notRun` lists the planned experiments that never started;
  - `budget.usedMs` says how long the run took.
- **The evidence is incomplete,** so [`compare`](compare.md) and [`verify`](verify.md) never read a stopped run as a fix.
- **Cleanup runs in the reserved time and is reported as it went.** The faults are removed and the final reload runs.
  - `finalReset` is `healthy` only when that reload matched the calibrated screen.
  - A final reload that can't finish in time leaves `finalReset: not-verified` with `CLEANUP_TIMEOUT` in `cleanupError`.
  - A final reload with no time left to start leaves `CLEANUP_SKIPPED`.

### Progress

While a run goes on, its report folder holds two files, rewritten after every reload. Each is written whole, so a reader never sees half a file.
- **`progress.json`** holds:
  - the phase: `starting`, `calibrating`, `checking-screen`, `experimenting`, `cleaning-up` or `finished`;
  - `completedLoads` of `plannedLoads`, `elapsedMs`, and `worstCaseRemainingMs`;
  - the planned and finished experiments;
  - the time left under `maxDurationMs`.

  Read it instead of waiting blindly for a long run.
- **`report.partial.json`** is the report so far. Its evidence block is never complete, and carries the gap `RUN_IN_PROGRESS`.

The final `report.json` replaces `report.partial.json` when the run ends. A run that is killed leaves both files behind.

### Stopping a run

Ctrl+C or SIGTERM stops a run at its next step, or its next look at the screen during a load. Cleanup still runs: the faults are removed and the final reload is made. The report is written with `stoppedReason: INTERRUPTED`, and the exit code is 2.

A process killed outright, such as with `taskkill /F`, or on Windows by a parent process, can't clean up:
- over IPC, the hook drops each armed fault plan at the end of its load's windows;
- over HTTP, the faults end with the connection;
- `progress.json` and `report.partial.json` show how far the run got.

## Experiments

| Over | Experiments |
| --- | --- |
| IPC | one rejection, two rejections in a row, one successful `null` result |
| HTTP | each fault in `faults` (`http-error`, `connection-failure`, `invalid-json`), `times` in a row |

Calibration also counts how often each healthy load reads the target (`readiness.callsPerLoad`). When every load reads it the same number of times, and more than once, discovery also fails the 2nd, 3rd and 4th call on its own: one rejection over IPC, the first listed fault over HTTP. Those findings have ids like `rejection-1-call2`. This catches a screen that ignores a failed prefetch but shows a failed second read as an empty list. When later calls aren't tried, `readiness.callsGap` says why: the counts differ between loads, a load reads more than four times, or the app runs an older IPC hook.

Last, every read of the target fails, up to 10 in a row, with the first experiment's fault, so the app's retries run out. Its finding, such as `rejection-every-read`, says what the screen shows when they do, and `failedReads` how many reads failed in each run: the app's attempts. An app that retries a few times recovers from one or two failed reads, but an outage that outlasts its retries can still leave the screen empty with no error; this is the experiment that shows it. An app that reads more than 10 times and then succeeds is `RECOVERED`. The screen must reach its final state within the observation window (`observationMs` over IPC, `recoveryTimeoutMs` over HTTP). An app still retrying when the window ends usually shows `LOADING_AT_DEADLINE`, and the finding's advice says to raise the window.

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

Each run writes `report.html`, `report.json` and `scenario.json` to a new folder under `.recovery-probe/` (or `--out`), and keeps `progress.json` there while it runs ([Progress](#progress)). The HTML report starts with the findings table. Reports hold counts, structural summaries, timings and hashes of screen text, never the text, payloads or credentials. A hash isn't anonymization, and channel names and paths can still be private.

The report's `page`, also printed first in the terminal, is the address of the tested page without credentials or query values. A route in the fragment, such as `#/users`, stays, so a run on the wrong screen shows at a glance; a fragment that carries values, such as a sign-in token, is left out.

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
