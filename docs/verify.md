# Verify a change

"Fixed" should mean the check that showed the problem no longer shows it, nothing else got worse, and the new code does not add the failure handling Recovery Probe looks for. `recovery-probe verify` checks all three in one step and says VERIFIED or NOT VERIFIED, so a developer or an AI coding agent has a clear bar to clear before calling a change done.

## The plan

List the checks that prove the change in `.recovery-probe/verify.json`. With a scenario registry, [`plan`](plan.md) (experimental) proposes them from the files the change touches and writes the same format:

```json
{
  "base": "main",
  "runs": 3,
  "checks": [
    {
      "name": "queue",
      "command": ["observe", "--config", "observe.json", "--steps", "steps.json"]
    },
    { "name": "add-contact", "command": ["action", "--config", "action.json"] }
  ]
}
```

- `checks`: 1–20 checks, each a name (letters, digits, `.`, `_`, `-`) and the arguments you would give the CLI. A check needs `--config`, and leaves out `--out`: verify gives every run its own folder.
- `runs`: how often each check runs on each side, 1–10. 3 by default, because a single run can be lucky.
- `base`: the Git reference the change starts from, `main` by default. Only lines changed since it are scanned for suspects.

`--plan FILE` reads the plan from elsewhere.

## Run it

1. Before changing the code, with the app in the state that shows the problem, record the starting point:

   ```bash
   npx recovery-probe verify --baseline
   ```

2. Change the code, restart or reload the app as needed, then:

   ```bash
   npx recovery-probe verify
   ```

Verify reruns every check, compares its runs with the baseline as [`compare`](compare.md) does, and scans the lines changed since `base` for [suspects](suspects.md). The change is **VERIFIED** only when:

- every check **improved**, or stayed **unchanged and clean**: a check that still finds a problem does not verify a fix for it;
- every run after the change is **complete**, and the baseline has a report for the check: an interrupted run proves nothing;
- the check is the one the baseline recorded: a changed command needs a new baseline;
- **no changed line is a suspect**. Prove or dismiss each one, and mark a reviewed line with `// recovery-probe-ignore`. The scan needs TypeScript in the project; without it, the change cannot be verified.

Otherwise it is **NOT VERIFIED**, with one reason per problem. The exit code is 0 when verified, 1 when a check found a new defect, and 2 for anything else to resolve.

Runs are kept in `.recovery-probe/verify/before` and `after`, one folder and log per run. Each `--baseline` replaces the earlier baseline, and each verify replaces the earlier `after` runs, but only once all of a side's runs have finished. `summary.md` is a block for the pull request, and `summary.json` holds the full result.

A run that ended before writing its report counts as incomplete. If it left a partial report, as `discover` does, its evidence is kept with the gap `PROCESS_STOPPED`, so it can never count as a fix.

### The report

`summary.json` keeps every field it has always had, with the same values: `verdict`, `exitCode`, `reasons`, `checks`, `suspects` and `directory`. These are added:

| Field | Meaning |
| --- | --- |
| `schema` | `recovery-probe/verification@1`. |
| `mode` | `plan`, or `policy` (below). |
| `run` | Its `id`, `status` (`completed`, `cancelled` or `failed`) and start and end times. |
| `revisions` | The base `ref` and the commit it resolved to, and the candidate's `head`, `snapshotTree` and `uncommittedChanges`. The snapshot tree is what Git would commit for the working tree, ignored files left out. It's made with a temporary index, so your index and branch stay as they were. |
| `verdictRules` | `recovery-probe/verdict-rules@1`: the rules that decided the claims. |
| `claims` | One per check, plus `suspects/changed-lines` for the scan. |

Each claim has an `id` such as `behavior/queue`, a `statement`, its `expectation`, an `outcome` (`VERIFIED`, `FAILED` or `NOT_VERIFIED`) with one `reason` code, its `execution` status and every attempt, the `baseline` comparison, the report files it rests on with their hashes, and its `gaps`. In plan mode, the expectation's source is `plan`, which nobody approves, and the verdict and exit code are decided as they always were.

While verify runs, `verification.partial.json` is rewritten after every run, so a long verification can be followed. A verification that stops still writes `summary.json`, with `run.status: "cancelled"` and every claim without a result as `NOT_RUN`. A missing result never counts as a pass.

### Stopping

Ctrl+C or SIGTERM stops verify, and no later run starts. The check in progress is asked to stop:

- `discover`, `observe` and `refresh` remove their faults and write their reports;
- a check that can't stop on its own, such as `check` or `action`, is ended at once;
- a check that hasn't stopped after 10 seconds is ended with every process it started.

Verify then exits with 2, and nothing is verified. A stopped `--baseline` keeps the earlier baseline.

## Policy mode (experimental)

A plan is a file the change itself can edit, so a plan can be weakened along with the code. In policy mode, the criteria come from the **base** instead: the version the team reviewed and merged.

```bash
npx recovery-probe verify --policy recovery-probe.policy.json --base main
```

- **The base comes from the command:** `--base`, or `base` on `verify_change`, never from a file in the working tree. In CI, pass the commit of the protected branch.
- **The policy and the registry are read as committed on the base.** The policy, `recovery-probe.policy.json`, owns the claims, project checks, budgets and ignore rules. Claims name [registry](plan.md#the-registry) scenarios: a `failurePath` that fails a read and a `normalPath` that checks the same screen without a fault, plus the `assertions` (names of `expect` steps) both must meet.
- **The base's files are the ones that run.** A claim's scenarios run with the configuration and step files copied from the base. The candidate's copies are only compared with them.
- **A change to the criteria needs review.** The report gives these reasons, with the approved and candidate versions and what changed:
  - `EXPECTATION_CHANGED` when the candidate edits a claim's registry entry or a file its scenarios read;
  - `POLICY_CHANGED` when it edits the policy;
  - `CHECK_INPUT_CHANGED` when it edits an input a project check names, such as `package.json#scripts.test`.

  The claim stays NOT_VERIFIED until the change is merged into the base. Its result against the approved version still shows.
- **Hashes use committed bytes**, as Git would store them, so line-ending conversion never makes a file look changed.
- **Coverage is strict.** A changed file that no claim's scenario `paths` cover, and that the base's `ignore` rules don't leave out, blocks VERIFIED and is listed in `coverage.uncovered`. A candidate's own ignore rules are never used.
- **Base provenance.** `baseProvenance` records the commit, whether CI supplied it, and whether it's on the remote branch of the same name. A local base that isn't adds the run gap `BASE_NOT_ON_REMOTE`, which blocks VERIFIED. Even a base on the remote branch proves neither branch protection nor review.

Exit codes keep their meaning: 1 only for a claim that failed with `NEW_FAILURE`, even when others are incomplete; 0 when every claim is verified and nothing blocks the run; 2 otherwise. A timeout is never a regression.

This version doesn't yet run everything a policy describes, so a policy run can't be VERIFIED yet:

- **Scenarios** run once per path, `runs` times, against an app someone started by hand. Recovery Probe can't tell which code that app runs, so each behavior claim has the gap `APP_REVISION_UNKNOWN`. Launching the app from each side's checkout, and so the base side, comes next.
- **Project checks** are judged and listed, but not run yet: `UNAVAILABLE`.

A policy doesn't make a local run tamper-proof. Anyone with a shell can change the base locally or edit files the run reads. The stronger setup is verify in CI, with the base supplied by CI.

## From an AI coding agent

The [MCP server](mcp.md) offers the same steps as `verify_change`: `baseline: true` before the change, and no arguments before saying it is done. Its instructions tell the agent not to call a change done while the verdict is NOT_VERIFIED. Cancelling the call stops its checks the same way as Ctrl+C, and `status: true` returns the last result, or the record of a run still going or stopped, without running anything. `policy` and `base` select policy mode.

## What it does not cover

Verify is only as good as its plan. It shows that the planned checks improved or stayed clean and that the changed lines add no known data-loss pattern; it does not review style, design or code it has no check for. [`self-check`](self-check.md) (experimental) shows whether a planned scenario can run and behaves the same on every run of a build you name, before you rely on it here.
