# Watch mode (0.5.0-preview.16)

`recovery-probe watch` keeps the evidence current while you change code. After each save it:

1. scans the changed files for [suspects](suspects.md);
2. reruns a check you give it against the running development app;
3. compares the run with the first one and with the one before, the way [compare](compare.md) does.

You see whether an edit fixed what the check found, or broke something, without running anything by hand. This works the same when an AI coding agent makes the edits.

## Run it

```bash
npx recovery-probe watch src -- ipc --action --config action.json
```

- **Paths** are the files and folders to watch; the default is the working directory. The watch skips `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.git`, `.recovery-probe` and editor swap files.
- **After `--`** goes the check, as you would run it but without `--out`. That is `--config FILE` for a browser recovery check, or `web`, `desktop`, `ipc`, `observe` or `refresh` with `--config FILE`. Options that need a person, such as `--interactive`, don't work in a watch.
- **Without a check**, the watch only scans changed files for suspects: `npx recovery-probe watch src`.
- **`--settle MS`** is how long the files must be quiet before a run, 1500 ms by default. It gives the dev server time to rebuild and reload the app first; raise it if runs start before the reload.
- **`--no-suspects`** turns the scan off.
- **`--max-runs N`** stops after N runs of the check, which is useful in scripts.
- **`--out NEW_DIRECTORY`** sets where the runs go; the default is `.recovery-probe/watch-TIME`.

Stop with Ctrl+C. The run in progress finishes first; a second Ctrl+C quits at once.

## What it shows

This example ran on the included demo page. The fix was simulated by pointing the check at the page that recovers, while a source file was edited:

```text
Watching src; each change reruns: recovery-probe --config scenario.json.
Runs and summary: .recovery-probe/watch-2026-10-20T18-29-09-776Z. Stop with Ctrl+C.

[20:29:09] starting point: running the check
  run 1: RECOVERY_ASSERTION_FAILED (HTTP 503 once), RECOVERY_ASSERTION_FAILED (Interrupted request once), RECOVERY_ASSERTION_FAILED (Malformed JSON once)

[20:29:15] changed: src/profile.ts
  suspects: 1
    src/profile.ts:1  UNKNOWN_AS_EMPTY  read: fetchProfile()
  run 2: IMPROVED since run 1: 3 problems gone (…), none new.
```

- **Run 1** is the starting point: the check before any change.
- **Each later run** is compared with run 1 and with the run before. The rules are those of `compare`, so a problem counts as gone only when a complete run checked it.
- **Folders and logs:** each run has its own folder (`run-N`) and log (`run-N.log`). A run that wrote no report shows the last line it printed.
- **Summaries:** `summary.json` lists every run with its problems and verdicts. `summary.md` is the pull request block for run 1 against the latest run. Both are rewritten after each run.
- **Exit code** when the watch stops is that of the latest comparison: 0 for improved or clean, 1 for a new suspected defect, 2 for anything else. It is 0 when there was nothing to compare.

## With an AI coding agent

Run the watch in a terminal next to the agent. After an edit, the agent can read `summary.json` in the watch folder to see whether the latest run is better or worse than the start. It can also call `find_suspects` and `compare_reports` over [MCP](mcp.md).

## Limits

- **It does not build, restart or reload the app.** The watch reruns the check against whatever app is running. A change that needs a restart, such as one to an Electron main process, needs your dev setup to restart the app, and a longer `--settle`.
- **A run that starts before the app has reloaded tests the old code.** If results lag behind a change, raise `--settle`.
- **Each run is a single run.** Problems that come and go need repeated runs; for a pull request, use `compare` with several runs per side.
- **Use development apps and test accounts only.** As with every check, runs reload pages and fail reads.
