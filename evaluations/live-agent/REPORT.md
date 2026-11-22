# Live-agent pilot 1: results

**In short:** on these six small tasks, the agent did equally well with and without Recovery Probe. Every attempt that finished with a report fixed its defect, left the control alone, or asked for clarification on the ambiguous task. The pilot found no regressions and no incorrect claims in either condition. Where agents used Recovery Probe, it reproduced the defect and confirmed the fix, and took about twice as long. The pilot shows a ceiling effect: it can't show a benefit or a harm on tasks this easy.

How the pilot was built is in [README.md](README.md), and what preparing condition B cost is in [setup-effort.md](setup-effort.md).

## What ran

| | |
| --- | --- |
| When | 17 November 2026, 18:55–19:21 UTC, 36 attempts one after another |
| Definition | frozen in commit `4f8f95f` ([`runs/pilot-1/frozen.json`](runs/pilot-1/frozen.json)); graders and reference apps sealed until every attempt had run. Recorded and graded as commit `a898e62`; to grade pilot-1 again, check out that commit |
| Agent | Claude Code 2.1.322, model `claude-sonnet-5-5`, effort high, at most 80 turns and 25 minutes, on a subscription |
| Condition B | Recovery Probe 1.2.0-preview.1 (MCP server and command) with five prepared scenarios |
| Order | shuffled with seed 20261117 ([`runs/pilot-1/schedule.json`](runs/pilot-1/schedule.json)) |
| Machine | Windows 11; the CLI's shell tool was PowerShell |

Every attempt's init event confirmed the same model and CLI version, the Recovery Probe server connected in B, and no MCP server in A.

## Measured results

These use the rules frozen before the run (`harness/score.mjs`, `grading/rules.json`). Every attempt is listed in [`runs/pilot-1/summary.md`](runs/pilot-1/summary.md). Its transcript, diff, report and grade are in `runs/pilot-1/attempts/<id>/`.

| | A | B |
| --- | --- | --- |
| Successes | 16/18 | 17/18 |
| Defects fixed (four fix tasks) | 11/12 | 12/12 |
| Attempts with regressions | 0 | 0 |
| Incorrect claims of "fixed" or "no change needed" | 0 | 0 |
| Unnecessary changes on the control | 0/3 | 0/3 |
| Clarification asked on the ambiguous task | 2/3 | 2/3 |
| Not completed (failed or timed out) | 1 | 0 |
| Isolation flags | 0 | 0 |
| Median minutes per attempt | 0.46 | 0.69 |
| Median turns | 14 | 13 |
| Median output tokens | 2,463 | 3,070 |
| Median cost (CLI estimate, USD) | 0.08 | 0.10 |
| Total cost (CLI estimate, USD) | 1.50 | 1.98 |

| Task | A successes | B successes | A median minutes | B median minutes |
| --- | --- | --- | --- | --- |
| refresh-clears-orders | 3/3 | 3/3 | 0.4 | 1.0 |
| health-gives-up | 3/3 | 3/3 | 0.4 | 1.0 |
| shipped-row-stale | 2/3 | 3/3 | 0.7 | 0.7 |
| filter-race | 3/3 | 3/3 | 0.5 | 0.5 |
| empty-notifications (control) | 3/3 | 3/3 | 0.4 | 0.5 |
| partial-sync (ambiguous) | 2/3 | 2/3 | 0.4 | 0.5 |

With three attempts per task and condition, these counts are not evidence of a difference in either direction.

### The three attempts without a final report

All three non-successes come from the same failure. Each agent's final structured report was malformed: tool-call parameter markup ended up inside the `status` string (`"needs_clarification</parameter>\n<parameter name=\"summary\">…"`). The CLI rejected the report and the agent retried, up to five times. This is a formatting error by the model in its tool call; the other 33 reports, including other `needs_clarification` reports, came through.

| Attempt | What the agent wrote in plain text | Scored as |
| --- | --- | --- |
| `16-shipped-row-stale-A1` | nothing; the CLI stopped after five retries. Its last report said `needs_clarification`, and it changed no code | no status; not fixed; execution failed |
| `23-partial-sync-B2` | `needs_clarification`, no code changed | no status, so not clarified |
| `36-partial-sync-A2` | `needs_clarification`, no code changed | no status, so not clarified |

The frozen rules read only the structured report, and the scores stay as they are. Read from the plain text, the ambiguous task would be 3/3 clarified in both conditions. Attempt 16 would remain not fixed under either reading. Neither reading changes the comparison.

## What the agents did

This part is descriptive, from the transcripts; it is not part of the frozen scoring. It's produced by [`analysis/describe.mjs`](analysis/describe.mjs) and saved in [`runs/pilot-1/behavior.md`](runs/pilot-1/behavior.md).

| | A | B |
| --- | --- | --- |
| Ran the app's tests | 13/18 | 13/18 |
| Ran the app | 4/18 | 12/18 |
| Drove a browser | 2/18 | 7/18 |
| Used Recovery Probe | – | 8/18 |
| Added or changed a test, on fix tasks | 11/12 | 10/12 |

- **Condition A** mostly read the code, fixed it and added a unit test. That was enough for every task here.
- **Condition B**
  - **Where it was used:** in 8 of 18 attempts, all on fix tasks, never on the control or the ambiguous task.
  - **Which tools:**
    - `plan_verification` in five attempts;
    - the prepared scenarios through `run_recovery_probe` in all eight;
    - `compare_reports` in three.
  - **Never used:** `verify_change` and `self_check_scenarios`.
  - **What they showed:**
    - In four attempts the scenario reproduced the defect before the fix: `RECOVERY_NOT_OBSERVED` twice on the health task, and `EXPECTATION_NOT_MET` once each on the ship and refresh tasks. In all four it came out clean afterwards.
    - The three before-and-after comparisons each said `IMPROVED`.
    - The other attempts ran a scenario only after the fix.
- **Time:** B attempts that used Recovery Probe took a median 1.1 minutes, those that did not 0.54, and A 0.46. Using it meant starting the app and the browser helper, then running the checks.

## Why the pilot shows no difference

- **The tasks were too easy for this model.** Each defect sat in one function of a small app, and the requirements named the exact behavior and messages. Reading the code was enough; Sonnet 5.5 fixed most tasks in under a minute. Even the timing-sensitive task was solved by reading the store, without reproducing the race.
- **Three attempts per task and condition** cannot detect anything but large effects.
- **The scenarios were prepared** by the evaluation's author, who knew where the defects were, and two app designs were chosen so that `observe` could work (see [setup-effort.md](setup-effort.md)). That favors condition B's setup, not its outcomes.

## Limits

- **Isolation on the Windows host.** File tools were denied the checkout, the key and Claude's own files, and both conditions had web tools off. Shell commands could not be confined, so a check flagged any tool call that named those places: there were no flags. The plain graders also existed in the evaluation author's own session files on the same machine. An attempt would have had to look for them deliberately; none named them.
- **Before freezing,** five smoke attempts checked the setup and are not counted. One showed that an agent's shell can affect the whole machine: it stopped every `chrome*` process. The prompt now asks both conditions to stop only their own processes. Two earlier freezes were replaced before any attempt was recorded: the first could not start and the second lost its first attempt in a cleanup error, unseen. The commits record both.
- **One model, one effort level, one runtime and one operating system.** Results for other models, or for Linux with shell sandboxing, may differ.
- **A record field can mislead.** If a session were killed at its time limit, `attempt.json` would also say "the CLI did not start" in `execution.error`, next to `timedOut: true`. No attempt timed out, and scoring reads `timedOut` first.
- **Costs are the CLI's own estimates.** The attempts ran on a subscription and were not billed per token.

## What the pilot does not show

- That Recovery Probe helps, or hurts, on harder tasks, such as defects spread over several files, requirements that are not written down, timing problems that the code does not reveal, or Electron and IPC apps.
- That an agent, or a team, would prepare working scenarios without help: this pilot measured only prepared ones.
- That the results hold for other models or settings.
- Any statistical claim.

A next pilot should use tasks that code reading alone does not solve, more attempts per task, and a model or effort level with headroom on them.

## Recommended next product improvement: scenario setup

The bottleneck this pilot observed is **setting up and running `observe` scenarios**, not the quality of the evidence: where agents ran the checks, the evidence was right.

- **Setting up.** Preparing the scenarios took six validation rounds, a browser helper and two app design changes, all because `observe` attaches only to a page that is already open and starts capturing after that page has loaded:
  - with the app's content already on screen, `CONTENT_BEFORE_READ` appeared on every run;
  - a page kept between runs carried state from one run to the next;
  - an agent restarting the helper to load its new code is how the stray process kill happened.
- **Running.** In condition B, the extra time went into running the app and the browser before any check could run.

Recommendation: let `observe` open the page itself and start capturing before it loads, as `check` already does. A scenario would then need no browser helper, no app start page, and no page left over from an earlier run. That would remove most of the setup cost seen here, for whoever writes scenarios and for agents running them. This PR does not add it.
