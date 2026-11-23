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

Each claim has an `id` such as `behavior/queue`, a `statement`, its `expectation`, an `outcome` (`VERIFIED`, `FAILED` or `NOT_VERIFIED`) with one `reason` code, in policy mode the candidate's `criteriaChange` if it made one, its `execution` status and every attempt, the `baseline` comparison, the report files it rests on with their hashes, and its `gaps`. In plan mode, the expectation's source is `plan`, which nobody approves, and the verdict and exit code are decided as they always were.

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
- **The policy and the registry are read as committed on the base.** The policy, `recovery-probe.policy.json`, owns the claims, project checks, budgets, ignore rules and test files. Claims name [registry](plan.md#the-registry) scenarios: a `failurePath` that fails a read and a `normalPath` that checks the same screen without a fault, plus the `assertions` (names of `expect` steps) both must meet.
- **An open question is a missing expectation.** A scenario with a `question` and no `check` leaves its claim NOT_VERIFIED with `EXPECTATION_MISSING`, and the claim's gap quotes the question, for a person to answer instead of the agent guessing.
- **The base's files are the ones that run.** A claim's scenarios run with the configuration and step files copied from the base. The candidate's copies are only compared with them.
- **A change to the criteria needs review.** The report gives these reasons, with the approved and candidate versions and what changed:
  - `EXPECTATION_CHANGED` when the candidate edits a claim's registry entry or a file its scenarios read;
  - `POLICY_CHANGED` when it edits the policy;
  - `CHECK_INPUT_CHANGED` when it edits an input a project check names, such as `package.json#scripts.test`;
  - `TEST_CHANGED` when it changes or deletes a test file ([below](#tests-are-criteria)).

  The claim stays NOT_VERIFIED until the change is merged into the base. Its result against the approved version still shows, and `criteriaChange` keeps the change whatever the outcome.
- **A new failure under the approved criteria still counts.** When the criteria that ran on the candidate are the approved ones, and they show a failure that's new since the base, the claim is FAILED with `NEW_FAILURE` and verify exits with 1, even though the candidate also changed the criteria. The reasons list both: the regression, and the change that still needs approval. Which criteria run depends on the change:

  | Change | What runs on the candidate | A new failure there |
  | --- | --- | --- |
  | `POLICY_CHANGED` | the base's policy: its commands, claims and scenarios | FAILED, exit 1, unless one of the check's inputs changed too |
  | `EXPECTATION_CHANGED` | the base's registry entry, with copies of the base's files | FAILED, exit 1 |
  | `CHECK_INPUT_CHANGED` | the approved command, reading the candidate's changed input | NOT_VERIFIED, exit 2: the candidate's own criteria may have caused it |
  | `TEST_CHANGED` | the approved command, running the candidate's changed tests | NOT_VERIFIED, exit 2, for the same reason |
- **Hashes use committed bytes**, as Git would store them, so line-ending conversion never makes a file look changed.
- **Coverage is strict.** A changed file that no claim's scenario `paths` cover, and that the base's `ignore` rules don't leave out, blocks VERIFIED and is listed in `coverage.uncovered`. A candidate's own ignore rules are never used.
- **Base provenance.** `baseProvenance` records the commit, whether CI supplied it, and whether it's on the remote branch of the same name. A local base that isn't adds the run gap `BASE_NOT_ON_REMOTE`, which blocks VERIFIED. Even a base on the remote branch proves neither branch protection nor review.

Exit codes keep their meaning: 1 only for a claim that failed with `NEW_FAILURE`, even when others are incomplete or the candidate changed the criteria; 0 when every claim is verified and nothing blocks the run; 2 otherwise. A timeout is never a regression.

### Tests are criteria

A change that weakens a test can make a project check pass. So in policy mode the project's tests are criteria too, like the policy and the scenarios:

```json
"testFiles": ["**/test/**", "**/*.test.*"]
```

- **Which files.** `testFiles` lists patterns, read from the base's policy like every criterion. Without it, the patterns are `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/*.test.*` and `**/*.spec.*`. `"testFiles": []` turns this off. Test files count whether or not `ignore` leaves them out of coverage.
- **A changed or deleted test needs approval.** Every project check is then NOT_VERIFIED with `TEST_CHANGED`, because its command runs the candidate's tests, and the changed files are in `expectation.changedInputs`. The run is NOT_VERIFIED too, even without project checks, and its reasons list the files. A person approves the change by merging it into the base, as for any criterion. For example, merge the test edit first: the code change then verifies against it, and the check's comparison is `RESOLVED_FAILURE`.
- **An added test only shows for review.** New tests can only strengthen verification, so they never block VERIFIED.
- **Renames.** A renamed test is deleted at its old path and added at its new one.
- **Review signals.** `reviewSignals` in `summary.json` lists `TEST_FILE_DELETED`, `TEST_FILE_CHANGED` and `TEST_FILE_ADDED`, each with its files. `summary.md` and the command's output show them.

Only files that match `testFiles` count. Tests weakened from elsewhere, such as a runner configuration that skips them or a mock outside the test folders, go unnoticed unless a check names that file in `inputs`.

### Each side's own app

A claim that names an `app` runs on both sides: the base and the candidate, each from its own checkout.

```json
"apps": {
  "web": {
    "setup": [],
    "launch": ["node", "server.mjs", "4173"],
    "url": "http://127.0.0.1:4173/items.html",
    "ready": { "url": "http://127.0.0.1:4173/health", "timeoutMs": 20000 },
    "fixtures": ["test/fixtures/items.json"]
  }
}
```

- **Checkouts.** The base commit, and a commit of the candidate's snapshot tree, are cloned into disposable folders outside the repository, as for [repair](repair.md). The snapshot commit is recorded in `revisions.candidate.snapshotCommit`. No ref moves, and the commit is never signed: it's a throwaway object.
- **Launch.** For each side in turn:
  - Recovery Probe refuses the run if `url` or `ready.url` is already in use, since it may be another build.
  - It copies the base's `fixtures` into the checkout, runs `setup`, and starts `launch` there with an allowlisted environment.
  - It waits until `ready.url` answers.
  - Then it opens `url` in a Chromium it starts on a free loopback debugging port. Each run starts from that page, with its own copy of the approved configuration pointed at that browser.
  - Afterwards the app, everything it started and the browser are stopped. The app's output is kept in `app.log`.
- **Comparison.** Each path's base and candidate runs are compared as [`compare`](compare.md) does. A failure that's new on the candidate is `NEW_FAILURE`, exit 1. A failure on both sides is `FAILING_ON_BOTH`, exit 2. A fix shows as `IMPROVED` in the claim's `baseline`.
- **Budgets.** `budgets.totalMs` limits the whole verification, setup and launches included, and `--budget` (`budgetMs` on `verify_change`) can only lower it.
  - A launch or run starts only if its worst case still fits before `budgets.cleanupReserveMs`, and each run stops at `budgets.scenarioRunMs`. A discovery's own `maxDurationMs` is capped at that too.
  - Work that doesn't fit is reported as `BUDGET_EXHAUSTED`, and `run.status` as `budget-exhausted`.
  - Verify prints the worst case before it starts.
- **Instability.** A failure and a pass of the same scenario are `UNSTABLE`. A failure on the failure path with a pass on the normal path is still a failure.

A claim without `app` runs `runs` times per path, on the candidate only, against an app someone started by hand. Recovery Probe can't tell which code that app runs, so the claim has the gap `APP_REVISION_UNKNOWN` and can't be VERIFIED. Electron apps aren't launched yet.

### Project checks

`projectChecks` are the policy's approved commands, such as type checking, linting and tests:

```json
"setup": [["node", "/path/to/npm-cli.js", "ci", "--ignore-scripts"]],
"env": ["DATABASE_URL"],
"projectChecks": [
  {
    "id": "unit-tests",
    "command": ["node", "--test", "test/unit"],
    "inputs": ["package.json#scripts.test"],
    "timeoutMs": 600000,
    "attempts": 1
  }
]
```

- **Each side in its own checkout.** The policy's `setup` runs once in each side's checkout, before the first command or app launch there. A setup that fails, or changes tracked files, stops that side.
- **Inputs.** `inputs` names what a command reads besides the tests: a file, `file#a.b` for one JSON value, or a pattern such as `config/**`. A pattern counts as changed when a file it matches is added, edited or removed.
- **Commands.** Each command is an argument array run without a shell, with an allowlisted environment plus the variables `env` names. `env` passes names, never values, and the report lists the names. Each attempt has its own `timeoutMs` and counts against the budget. On Windows, run npm through Node and its CLI file, as for [repair](repair.md#windows-commands).
- **Full logs.** Each attempt's output is kept whole in `policy/<side>/project/<id>/attempt-N.log`, with its hash in the claim's evidence.
- **Contamination.** A command that changes tracked files gets `CHECK_MODIFIED_TRACKED_FILES`, and the files are put back before the next command.
- **Comparison**, by exit code:

  | Base | Candidate | `baseline.comparison` | Claim |
  | --- | --- | --- | --- |
  | passed | passed | `STILL_PASSING` | VERIFIED |
  | passed | failed | `NEW_FAILURE` | FAILED, exit 1 |
  | failed | failed | `FAILING_ON_BOTH` | FAILED, exit 2: a new failure can hide among the old ones |
  | failed | passed | `RESOLVED_FAILURE` | VERIFIED |
  | not completed | either | `NOT_COMPARABLE` | the candidate's result, with the base's status as a gap; a failure isn't proven new |

  A failure and a pass across `attempts` (1–3) are `UNSTABLE`. Only exit codes count, so a claim can't tell an old test failure from a new one. Its gaps say so.
- **Environment.** `environment` records Node, the platform, the variable names passed and each side's lockfile hashes. A lockfile that differs is part of the change.

`recovery-probe verify --propose-checks` (or `proposeChecks` on `plan_verification`) reads the project's configuration and proposes `setup` and `projectChecks` with the evidence for each. It looks at `tsconfig.json`, ESLint configuration, `package.json` scripts that run a type checker, linter or test runner, test runner configuration, and lockfiles. It never runs anything. What it can't decide goes to a person: several test scripts, a script that chains commands, starts a server or sets variables, and lockfiles other than npm's. Copy what you approve into the policy; it counts once merged into the base.

`npm run eval:verifier` verifies changes to a synthetic app, with one behavior claim and a unit-test project check, through thirteen cases: a fix, a regression, a fault that never fires, a missing and a changed expectation, a budget stop, a regression made alongside an edit to the policy or to the expectation, a weakened test, an added test, an intended test edit before and after its approval, and a changed test under a policy without project checks. It scores each against `test/fixtures/verifier-evaluation/expected.json`, which the verifier never reads.

A policy doesn't make a local run tamper-proof. Anyone with a shell can change the base locally or edit files the run reads. The stronger setup is verify in CI, with the base supplied by CI.

## From an AI coding agent

The [MCP server](mcp.md) offers the same steps as `verify_change`: `baseline: true` before the change, and no arguments before saying it is done. Its instructions tell the agent not to call a change done while the verdict is NOT_VERIFIED. Cancelling the call stops its checks the same way as Ctrl+C, and `status: true` returns the last result, or the record of a run still going or stopped, without running anything. `policy` and `base` select policy mode.

## What it does not cover

Verify is only as good as its plan. It shows that the planned checks improved or stayed clean and that the changed lines add no known data-loss pattern; it does not review style, design or code it has no check for. [`self-check`](self-check.md) (experimental) shows whether a planned scenario can run and behaves the same on every run of a build you name, before you rely on it here.
