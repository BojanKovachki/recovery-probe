# Before and after

A fix is easier to trust with evidence: the same check showing the problem without the change and not with it. `recovery-probe compare` reads reports of the same check from before and after a change, such as main and a pull request branch. It says what happened to each problem the check found, and writes a Markdown block for the pull request.

## Run it

1. On main, start the app and run the check, saving its report:

   ```bash
   npx recovery-probe ipc --action --config action.json --out .recovery-probe/before
   ```

2. Switch to the branch, rebuild and start the app the same way, and run the same configuration:

   ```bash
   npx recovery-probe ipc --action --config action.json --out .recovery-probe/after
   ```

3. Compare the two:

   ```bash
   npx recovery-probe compare --before .recovery-probe/before --after .recovery-probe/after --before-label main --after-label "this branch" --markdown
   ```

Each side takes one or more reports. A report can be:
- a `report.json` file;
- a report folder;
- a folder of report folders, one per run.

Give several runs per side when a problem does not show every time, as observation leads often don't. For example, `--before runs/main --after runs/branch`, where each folder holds `run-1`, `run-2` and `run-3`.

The default output is a terminal summary. `--markdown` prints the block for a pull request, and `--json` prints the whole comparison.

It reads the reports of:
- recovery checks: `--config`, `web`, `desktop`, `ipc`, guided start and attached checks;
- discovery: `ipc --discover` and `web --attach --discover`;
- `ipc --action`, `refresh` and `observe`.

Both sides must come from the same kind of check on the same target, which is an endpoint, an IPC channel or an observed read. Otherwise the result is `NOT_COMPARABLE`.

## How it decides

- **Problems** are suspected defects and leads.
  - Suspected defects include failed checks, `CONTENT_LOSS` and `SILENT_FAILURE`.
  - Leads are findings that need a decision, such as `UNCLEAR_FEEDBACK`, and observation findings, such as `DELAYED_UI_UPDATE` or `LOCAL_FILES_REMOVED`.
  - Other outcomes, such as `RECOVERED` or `FEEDBACK_SHOWN`, are listed but not compared.
- **Found** counts from any run, even one that stopped early.
- **Gone** counts only from a complete run that checked the same fault.
  - A run is not complete when it stopped with an error, its control run failed, all its results were inconclusive, or the observation reported a coverage gap.
  - A fault is not checked in a run when its result was inconclusive, for example because the fault was not triggered.

So a run that stopped early never reads as a fix. Each problem ends up as one of these:
- **gone**: found before, and absent from a complete run after;
- **new**: absent from a complete run before, and found after;
- **still there**: found on both sides;
- **not checked to the end**: found on one side, and no complete run on the other side checked it.

| Verdict | Meaning | Exit code |
| --- | --- | --- |
| `IMPROVED` | Problems gone, none new and none left | 0 |
| `PARTLY_IMPROVED` | Some gone; others still there or not checked to the end | 2 |
| `REGRESSED` | New problems after the change | 1 for a new suspected defect, otherwise 2 |
| `MIXED` | Some problems gone and some new | 1 for a new suspected defect, otherwise 2 |
| `UNCHANGED` | The same problems on both sides (2), or no problem on either side (0) | 0 or 2 |
| `INCONCLUSIVE` | Too few complete runs to tell | 2 |
| `NOT_COMPARABLE` | Different checks or targets | 2 |

No problem on either side is not evidence of a fix. It means the check did not reproduce the problem before the change, so reproduce it first.

## Example

```markdown
**Recovery Probe: before and after** · IPC action check · `contacts:add`

| Problem | main | this branch | Change |
| --- | --- | --- | --- |
| `SILENT_FAILURE`, suspected defect | 1 of 1 run | none in 1 complete run | gone |
| `DUPLICATE_SUBMIT`, suspected defect | 1 of 1 run | none in 1 complete run | gone |

Other outcomes: main none; this branch `FEEDBACK_SHOWN`, `SINGLE_SUBMIT`.

Runs: main 1 run, 1 complete; this branch 1 run, 1 complete.

**Improved:** 2 problems gone (SILENT_FAILURE, DUPLICATE_SUBMIT), none new.

Covers only this check. One scripted action on the current screen. …
```

## From an AI coding agent

The [MCP server](mcp.md) has a `compare_reports` tool. It takes `before`, `after`, `beforeLabel` and `afterLabel`, and returns the comparison with its Markdown. When an agent connects, the server tells it to compare reports before it says a change fixed something, and to quote the verdict.

## How it was checked

It was run on reports saved while fixing bugs in a production Electron app:
- **A write check, before and after a fix for a save that failed silently.** The result was `IMPROVED`, with three suspected defects gone.
- **Three observation runs on each side of a fix for a delayed row update.** The result was `IMPROVED`: the lead showed in 3 of 3 runs before and in none of 3 complete runs after.
- **Two discovery comparisons where every run after the fix stopped early.** The result was `INCONCLUSIVE`. A plain diff of the findings would have shown the problems as gone.

## Limits

- It compares what the reports recorded. Running the same configuration, data and environment on both sides is up to you: different accounts, data or timing can change a result without any change to the code.
- One run per side shows a problem once. Problems that come and go need repeated runs.
- The Markdown names the check's target, which is an endpoint or an IPC channel. Check it before you post it outside your team.
- It reads reports written by Recovery Probe 0.4.0 or later. The CI example's own summary is not a report it can read.
