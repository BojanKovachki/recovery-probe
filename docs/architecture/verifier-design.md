# Verifier design: evidence before "done"

**Status: design approved with the owner's decisions in section 12 (2026-11-20). Implementation proceeds one reviewed PR at a time, starting with PR 1.**

Before a coding agent says a change is done, Recovery Probe should show which claims about the change were checked, the evidence for each, and what stays unverified. This document extends [`verify`](../verify.md) and the MCP tool `verify_change` toward that goal, in small reviewable steps.

It isn't a correctness checker. Passing the approved checks shows that those checks passed on that code, in that environment. It never shows that the feature as a whole is correct.

Contents:

1. [Current capabilities and gaps](#1-current-capabilities-and-gaps)
2. [Scope and non-goals](#2-scope-and-non-goals)
3. [Workflow and trust boundaries](#3-workflow-and-trust-boundaries)
4. [Data contracts and example reports](#4-data-contracts-and-example-reports)
5. [Command detection, approval and isolation](#5-command-detection-approval-and-isolation)
6. [Base-versus-candidate comparability](#6-base-versus-candidate-comparability)
7. [Budgets, cancellation and partial results](#7-budgets-cancellation-and-partial-results)
8. [Compatibility and migration](#8-compatibility-and-migration)
9. [Pilot benchmark protocol](#9-pilot-benchmark-protocol)
10. [Implementation sequence](#10-implementation-sequence)
11. [Acceptance criteria and tests](#11-acceptance-criteria-and-tests)
12. [Decisions](#12-decisions)

## What the evidence so far supports

The [real-app study](../../evaluations/real-app-study/REPORT.md) ran 24 agent sessions, with and without Recovery Probe, on two proprietary applications. Nobody else can rerun it. Its numbers are small counts, and they describe; they don't establish anything general:

| | Without Recovery Probe | With Recovery Probe |
| --- | --- | --- |
| Distinct known defects found (of 9) | 7 | 9 |
| Distinct confirmed new defects | 28 | 26 in the merged report; 25 after a correction that is still open (PR #117) |
| Wrong claims | 3 | 0 |
| Total minutes | 94 | 140 |
| Timeouts | 0 | 1 |
| CLI cost estimate | complete | one attempt has none, so the costs can't be compared in full |

Most known defects came from an earlier Recovery Probe hunt on the same screens, which favours the tool. Results on the held-out screens were mixed. The two defects only the tool-assisted agents found need triggers agents rarely try: a `null` result, and a read that fails until the app's retries run out.

What this supports for the design:

- **Systematic fault selection and fewer wrong claims are worth keeping.** That's where the tool helped, so `verify` should keep running the failure paths an agent wouldn't choose.
- **Unbounded runs are a real cost.** In the timed-out session, the agent started discovery as a detached background process, outside the MCP tool's time limit, and waited with fixed sleeps. Nothing showed progress or an expected end, and the session ran out before discovery finished.
  - Section 7 addresses this first.
  - Nothing in the study shows the tool makes an agent find more defects overall, or finish faster.

## 1. Current capabilities and gaps

### What exists

| Capability | Where | Notes |
| --- | --- | --- |
| Verify plan | `src/tools/verify.mts`: `VerifyPlan`, `verifyPlan` | `{ base, runs, checks }`. Unknown keys are rejected (lines 41-43). Checks are `check`, `discover`, `action`, `observe` or `refresh` with `--config` (`validateCheckCommand`, `src/tools/watch/checks.mts:19`). |
| Baseline and verify | `recordBaseline`, `verifyChange`, `verifyCheck` in `src/tools/verify.mts` | Each side's runs go in `.recovery-probe/verify/{before,after}/<check>/run-N`. `baseline.json` records only `{ at, checks }`. VERIFIED needs every check `IMPROVED` or clean `UNCHANGED`, complete runs, the same command as the baseline (line 202), and no suspect on a changed line. |
| Exit codes and output | `Verification` in `src/tools/verify.mts:162`; `src/cli/verify.mts` | 0 verified, 1 a new defect, 2 anything else. `summary.md` and `summary.json` are written at the end (lines 327-332). |
| MCP `verify_change` | `verifyChangeTool`, `src/tools/mcp/change-tools.mts:119` | Same as the CLI; returns the verdict, reasons and per-check results. |
| Comparison | `compareRuns` (`src/tools/compare/run.mts:87`), `verdictOf` (`verdict.mts:63`), types in `src/tools/compare/types.mts` | `ChangeStatus` is `GONE`, `NEW`, `STILL` or `UNVERIFIED`. Verdicts run from `IMPROVED` to `NOT_COMPARABLE`. A problem is gone only from a complete run that checked its scope. |
| Evidence block | `EVIDENCE_SCHEMA = 'recovery-probe/evidence@1'`, `Evidence` (`src/reports/evidence.mts:2,19`) | `complete`, `gaps`, `problems`, `outcomes`, `checked`, the same for every workflow. |
| Planner (experimental) | `planVerification` (`src/tools/plan/plan.mts:215`), `PlanReport` (`:65`), registry in `src/tools/plan/registry.mts` | It maps changed files (`changesSince`, `changes.mts:105`) to registered checks. Registry entries carry `behavior`, `expectation`, `limits` and `question` as text. The report has `uncovered`, `needsInput` and `limits`. `--expect` adds an expectation "for this plan only". |
| Baseline status | `baselineStatus` (`src/tools/plan/baseline.mts:44`) | It can't tell which code a baseline ran against, and warns using file modification times. |
| Self-check (experimental) | `preflightCheck` (`src/tools/scenarios/preflight.mts:128`), `ScenarioInput { path, sha256 }` (`:17`) | It hashes the files a check reads. The planner shows `inputsChanged` (`src/tools/plan/self-check-status.mts:22`). |
| Machine-checkable assertions | `expect` steps in `src/workflows/observe/steps.mts` | When nothing matching shows in time, the step is `unmet` and the report gets `EXPECTATION_NOT_MET`. See [Scripted steps](../observe.md#scripted-steps---steps). |
| Partial evidence inside discovery | `INCOMPLETE_EXPERIMENT` with `completedRuns` and `plannedRuns` (`src/workflows/discover/experiment.mts:136-180`) | Only when the run reaches its conclusion. |
| MCP cancellation | `McpTool.run(args, { signal })` (`src/tools/mcp/server.mts:16-18`), `notifications/cancelled` (`:142`), abort on stdin close (`:102-105`) | Only `run_recovery_probe` uses the signal: `spawn(..., { signal, timeout })` with a default of 300000 ms (`src/tools/mcp/cli-tool.mts:63-72`). |
| Isolated checkout | `prepareWorkspace`, `assertTrackedUnchanged` (`src/tools/repair/workspace.mts:90,116`) | Repair (experimental) clones the committed `HEAD` without hardlinks, detaches it, removes `origin`, and runs Git with hooks disabled (`:24`). |
| Command execution | `validateCommand`, `executionEnvironment`, `startCommand`, `runCommand` (`src/tools/repair/process.mts`) | Argument arrays, `shell: false`, an allowlisted environment, a timeout, and process-tree stop (`taskkill /T /F` on Windows, process group elsewhere). Output keeps only the last 32000 characters (line 56). |
| App launch per checkout | `observeRepairTarget` (`src/tools/repair/target.mts:79-111`) | Launches the app from the checkout at a loopback address, refuses a port already in use, and stops it afterwards. |
| An outcome that names missing tests | `'scenario-passed-tests-missing'` (`src/tools/repair/run.mts:52`) | A passing scenario without regression tests isn't called verified. |
| Evaluations | `npm run eval:planner`, `npm run eval:self-check` | Synthetic apps with `expected.json` hidden from the tool. [A future live-agent comparison](../plan.md#a-future-live-agent-comparison) is sketched but hasn't been run. |

### Gaps this design closes

| Gap | Evidence |
| --- | --- |
| G1. No project checks. Type checking, linting and tests aren't part of verify. | [plan.md limits](../plan.md#limits): "Keep type checking, tests and review." |
| G2. No command detection or approval. | Nothing proposes or approves project commands. |
| G3. Verify never checks out the base itself, and doesn't record which code each side ran. | `baseline.json` is `{ at, checks }` (`verify.mts:96-99`), and `baselineStatus` says it can't tell. |
| G4. Criteria live in the candidate's working tree. The registry, the plan and the check configurations are all files the agent can edit, and verify compares only the command array. | `verify.mts:202`. Self-check hashes inputs, but verify doesn't use them. |
| G5. One verdict for the whole change. | No per-claim identity, outcome, execution status, revisions or policy identity. |
| G6. No budgets on verify runs. | `runRecoveryProbe` has no timeout or signal (`watch/checks.mts:43-55`). `verify_change` ignores the MCP signal. There's no overall deadline. |
| G7. Discovery has no overall budget, estimate or progress, and its report is written only at the end. | Timing options are per phase (`discover/load.mts:128-134`). `writeDiscoveryReport` runs after the run (`src/reports/discovery.mts:24`). A killed run leaves the folder and any screenshots. |
| G8. Cleanup is skipped when a run is killed. | `discover`, `check`, `action` and `verify` have no SIGINT/SIGTERM handling. The MCP timeout kills only the direct child. Over IPC, the hook's fault TTL (`ttlMs`, `discover/ipc.mts:186-192`) is the remaining safeguard. Over HTTP, routes end with the CDP connection. |
| G9. Logs are truncated, so a long test log loses its first failures. | `repair/process.mts:56` keeps the last 32000 characters. |

## 2. Scope and non-goals

The next version adds five things to verify and `verify_change`, and nothing else:

1. **Approved project checks.** Type checking, linting and tests, proposed from project configuration and run only once a person approves them.
2. **Base versus candidate.** The same approved checks in disposable checkouts of both revisions, with new, pre-existing and resolved failures kept apart.
3. **One approved behavioral claim.** A normal-path check and an existing Recovery Probe failure-path check, tied to one approved expectation.
4. **A structured evidence report.** Per-claim identity, outcome, execution status, evidence and gaps, under deterministic aggregation rules.
5. **Bounded execution.** Budgets, cancellation and durable partial results, starting with discovery.

**Non-goals:**
- a universal autonomous QA agent;
- a model deciding pass or fail;
- a new test runner, linter or type checker;
- zero-configuration support for arbitrary repositories;
- any guarantee of finishing within a minute;
- mapping changed files to screens automatically;
- detecting intentional cheating;
- a second package, a hosted service or telemetry.

Recovery Probe stays one npm package.

## 3. Workflow and trust boundaries

### Workflow

```text
owner                         agent                          recovery-probe
-----                         -----                          --------------
writes policy + registry  ->  (reviewed, merged to base)
                              plan_verification          ->  selects claims for the changed files
                              changes the code
                              verify_change              ->  reads the approved policy from the BASE revision
                                                             snapshots the candidate working tree
                                                             per claim, within budget:
                                                               base checkout: setup, approved commands
                                                               candidate checkout: the same
                                                               behavioral claim: launch app per side,
                                                                 normal-path + failure-path checks,
                                                                 approved check files from the base
                                                             writes evidence after every attempt
                                                             aggregates -> VERIFIED / NOT_VERIFIED
                              quotes verdict + gaps
reviews the report        <-
```

### Inputs and trust

| Input | Who controls it | Where verify reads it from | Identity recorded | What a candidate change does |
| --- | --- | --- | --- | --- |
| Candidate code and tests | the agent | a snapshot commit of the working tree | snapshot tree hash and `HEAD` | Nothing: this is what's under test. |
| Approved expectations: registry entries for the claim, check configurations, steps | the owner, through review | the **base** revision (`git show <base>:<path>`), copied into the run folder | sha256 of each file's committed bytes, plus the claim's expectation version | `EXPECTATION_CHANGED`: the claim is NOT_VERIFIED until the change is approved. |
| Approved commands, budgets and claim list (`recovery-probe.policy.json`) | the owner, through review | the base revision | sha256 of the committed bytes, with base ref and commit | `POLICY_CHANGED`: every claim it governs is NOT_VERIFIED. |
| Inputs an approved command depends on, such as the `package.json` script it runs or `tsconfig.json` | the owner names them in the policy (`inputs`) | both revisions, compared | sha256 per side | `CHECK_INPUT_CHANGED` on that claim: NOT_VERIFIED until approved. |
| Verdict rules | the installed package | code | package version and `recovery-probe/verdict-rules@1` | Not detectable if the installed package is modified. |

### Where approval comes from

In this design, **approved means present on the base revision** (decision 1). A team protects its base branch and reviews changes to the policy, the registry and the check files there, ideally with code owners. Recovery Probe records the base ref, its commit and each file's hash, so a reader can see exactly which criteria were applied. It can't see whether the base was protected or reviewed.

The base ref comes from the invocation: `--base`, or `base` on `verify_change`. It never comes from a file in the working tree. Today's plan `base` is in a file the agent can edit, and could name a commit the agent made itself.

The report keeps the base's provenance in its own `baseProvenance` record, apart from the claims:
- the ref as given, and the commit it resolved to;
- who supplied it: `ci`, when the CI environment passes it, or `local`;
- whether the commit equals, or is an ancestor of, the remote-tracking branch of the same name, such as `origin/main` for `main`. This shows only that the commit is on the remote branch. It doesn't prove branch protection or human review.

A local base that isn't on that remote branch adds the run-level gap `BASE_NOT_ON_REMOTE`, which blocks the overall VERIFIED. Every local report says plainly that the criteria came from a local checkout and that Recovery Probe can't tell whether anyone reviewed them. The trusted form is CI supplying the base commit from the protected branch.

Approved check files are read from the base and copied into the run folder. The candidate's own copies are only compared with them, never used. So editing an `expect` step in the patch can't weaken the check that runs. It shows up as a changed expectation instead.

### Renewed approval

An intentional change to an expectation, such as new required wording or a new failure behavior, is legitimate. It goes through review like any code:

1. Verify reports the claim as `NOT_VERIFIED` with `EXPECTATION_CHANGED`. It shows the approved and candidate versions, which inputs changed, and the result of the approved version on the candidate when that can still run. If the candidate fails the old expectation, that's the change working as intended. The claim stays unverified until the new expectation is approved.
2. A reviewer approves by merging the expectation change into the base, on its own or as part of the reviewed pull request. The next verify against that base uses the new version.

The first version has no other way to approve (decision 1): no acceptance flag, and no approvals file in the candidate. An expectation changed in a pull request stays NOT_VERIFIED until it's reviewed and merged. Trusted approval before merge can come later.

### Limits of this boundary

- **This is tamper-evident for in-patch changes, not tamper-proof.** An agent with a shell on the machine can change the base ref locally, rewrite local history, edit the installed package, fake report files, or run commands that alter the environment. A local run can't defend against any of that.
  - The stronger setup is to run verify in CI, with CI supplying the base commit. There the policy comes from the protected branch, and the candidate is untrusted input.
  - The report never claims cryptographic or adversarial independence.
- **Approved commands are executable code.** `npm test` runs the candidate's test files and the candidate's `package.json` script. The policy can pin the script text through `inputs`, but the test files themselves are the candidate's. Weakened tests are a review matter: verify lists changed and deleted test files as review signals (section 4). They don't decide the verdict.
- **A checkout isn't a sandbox.** See section 5.

## 4. Data contracts and example reports

### Policy: `recovery-probe.policy.json` (committed, approved at the base)

```json
{
  "schema": "recovery-probe/policy@1",
  "setup": [["node", "/path/to/npm-cli.js", "ci", "--ignore-scripts"]],
  "projectChecks": [
    {
      "id": "typecheck",
      "command": ["node", "node_modules/typescript/bin/tsc", "--noEmit"],
      "inputs": ["tsconfig.json"],
      "timeoutMs": 300000
    },
    {
      "id": "unit-tests",
      "command": ["node", "--test", "test/unit"],
      "inputs": ["package.json#scripts.test"],
      "timeoutMs": 600000,
      "attempts": 1
    }
  ],
  "claims": [
    {
      "id": "items-keep-content",
      "failurePath": "items-keep-content",
      "normalPath": "items-healthy",
      "assertions": ["items-visible", "refresh-error-shown"],
      "app": "web"
    }
  ],
  "apps": {
    "web": {
      "setup": [["node", "/path/to/npm-cli.js", "ci"]],
      "launch": ["node", "server.js"],
      "url": "http://127.0.0.1:4173/items",
      "ready": { "url": "http://127.0.0.1:4173/health", "timeoutMs": 60000 },
      "fixtures": ["test/fixtures/items.json"]
    }
  },
  "budgets": { "totalMs": 1800000, "scenarioRunMs": 300000, "cleanupReserveMs": 60000 },
  "ignore": ["docs/**", "*.md"]
}
```

The policy and the registry each own one thing (decision 2):

- **The policy owns** approved commands, app launches, budgets, required claims and ignore rules.
- **The registry owns** scenario definitions: each scenario's `check`, `behavior`, `expectation` and `limits`.
- **Claims reference scenarios by ID:**
  - `failurePath` and `normalPath` are registry scenario names, never copies of their commands;
  - the failure-path scenario's `check` fails a read;
  - the normal-path scenario checks the same screen with no fault;
  - their `behavior`, `expectation` and `limits` are the claim's text.
- **`assertions`** names the `expect` steps that must be met on both paths. They're machine-checkable, and the registry text says what they stand for.
- **Commands** are argument arrays, never shell strings. On Windows, run npm through Node and npm's CLI JavaScript entry point, as for [repair](../repair.md#windows-commands). The `/path/to/npm-cli.js` above is a placeholder for that path.
- **`apps`** launches a web app from each side's checkout (decision 5):
  - there's an explicit readiness check (`ready`) and approved fixtures;
  - every process is owned by the run, an occupied port is refused, and the app is stopped after each side.
  - Electron apps aren't launched automatically yet, and existing Electron checks keep working as they do.
- **A claim without `app`** runs against an app someone started by hand, as verify does today. Recovery Probe then can't tell which code the app ran, so the claim records the gap `APP_REVISION_UNKNOWN` and can't be VERIFIED in policy mode. That includes any manually attached Electron app.

### From a requirement to an approved assertion

1. The owner writes the requirement as the registry entry's `expectation`, with its source, such as a ticket or a product decision.
2. The owner writes, or asks someone to write, the scenario that checks it: steps that reach the state, and `expect` steps for what must show. One example is `{ "expect": { "role": "alert" }, "name": "refresh-error-shown" }`.
3. The claim lists those step names under `assertions`, and the change goes through review into the base. That makes the assertion approved.
4. Recovery Probe never turns text into assertions.
   - A requirement with no scenario stays a `question` or a missing expectation in the [plan](../plan.md#the-registry), and its claim is NOT_VERIFIED with `EXPECTATION_MISSING`.
   - `plan --expect` text stays "stated for this plan": the report records it, but it can't make a claim VERIFIED.

### The report: `summary.json`, with `schema: "recovery-probe/verification@1"`

All of today's fields stay with their current meaning: `verdict`, `exitCode`, `reasons`, `checks`, `suspects`, `directory`, `markdown`. These fields are added:

```json
{
  "schema": "recovery-probe/verification@1",
  "mode": "policy",
  "run": {
    "id": "20261120T101200Z-3f2a",
    "status": "completed",
    "startedAt": "2026-11-20T10:12:00Z",
    "endedAt": "2026-11-20T10:31:07Z",
    "budget": { "totalMs": 1800000, "usedMs": 1147000 }
  },
  "revisions": {
    "base": { "ref": "origin/main", "commit": "4f1c2a9e" },
    "candidate": { "head": "9b2e7c10", "snapshotTree": "1d4e8a33", "uncommittedChanges": true }
  },
  "baseProvenance": {
    "ref": "main",
    "commit": "4f1c2a9e",
    "suppliedBy": "local",
    "onRemoteTracking": { "ref": "origin/main", "result": "ancestor" },
    "note": "Criteria came from a local checkout. Recovery Probe can't tell whether the base was protected or reviewed."
  },
  "policy": {
    "path": "recovery-probe.policy.json",
    "source": "base",
    "commit": "4f1c2a9e",
    "sha256": "5e0c…",
    "changedInCandidate": false
  },
  "verdictRules": "recovery-probe/verdict-rules@1",
  "environment": { "node": "v22.13.0", "platform": "linux-x64", "envNames": ["CI", "LANG", "PATH"] },
  "claims": [],
  "coverage": { "uncovered": ["src/theme.js"], "ignored": ["README.md"] },
  "reviewSignals": []
}
```

Each claim:

| Field | Meaning |
| --- | --- |
| `id` | Stable: `project/<check id>`, `behavior/<claim id>`, or `suspects/changed-lines`. |
| `kind` | `project-check`, `behavior` or `suspect-scan`. |
| `statement` | What the claim says, from the policy or the registry. |
| `expectation` | `{ approvedVersion, candidateVersion?, source, approved }`. A version is `sha256:` over the canonical claim definition and the bytes of every input it reads. |
| `outcome` | `VERIFIED`, `FAILED` or `NOT_VERIFIED`: what the evidence says about the claim. |
| `reason` | One code for the outcome, such as `NEW_FAILURE` or `FAULT_NOT_TRIGGERED`. |
| `execution` | `{ status, attempts[] }`. The status says what happened to the work: `completed`, `failed-to-start`, `timed-out`, `cancelled`, `budget-exhausted`, `skipped` or `unavailable`. Every attempt stays listed. |
| `baseline` | The same claim's result on the base and its comparison (section 6), or `{ status: "not-applicable" }`. |
| `evidence` | Artifact references: report folders, logs and screenshots, each with a path relative to the run folder and a sha256. |
| `gaps` | What this claim doesn't cover or couldn't check, from the scenario's `limits`, the run's gaps, and missing per-test detail. |

Execution status and claim outcome are separate fields. A completed execution can still leave a claim NOT_VERIFIED, for example when a fault never fired. A timed-out execution can't make a claim VERIFIED.

### Aggregation rules (`recovery-probe/verdict-rules@1`)

Per claim, the first rule that applies decides:

1. Its approved expectation is missing → `NOT_VERIFIED`, `EXPECTATION_MISSING`.
2. The candidate changed the claim's criteria → `NOT_VERIFIED`, with `POLICY_CHANGED`, `EXPECTATION_CHANGED` or `CHECK_INPUT_CHANGED`. The result against the approved, older expectation is still shown (decision 1).
3. A candidate attempt observed a failure. That means a command that completed with a non-zero exit, an unmet assertion, or a suspected defect. A failure counts from any run, even one that stopped early, as `compare` counts problems.
   - If another attempt of the claim completed and passed → `NOT_VERIFIED`, `UNSTABLE`. Every attempt is kept.
   - Otherwise → `FAILED`, with the reason from the comparison (section 6).
4. The candidate's execution status isn't `completed` → `NOT_VERIFIED`, with the status as the reason.
5. The candidate's evidence is incomplete (a gap, an unmet control, a fault that didn't fire, an unknown app revision) → `NOT_VERIFIED`, with the first gap.
6. Otherwise → `VERIFIED`, for what the claim states and within its `gaps`.

For the whole run:

- **Verdict.** `VERIFIED` only when all of these hold. Otherwise `NOT_VERIFIED`.
  - every claim the policy requires for the change is VERIFIED;
  - a policy identity is recorded;
  - there's no run-level gap, such as `BASE_NOT_ON_REMOTE`;
  - in policy mode, no changed file is uncovered.
- **Coverage is strict in policy mode** (decision 3).
  - A changed file outside the ignore rules that no claim covers blocks the overall VERIFIED. Each uncovered file is listed. Covered claims are still reported VERIFIED on their own.
  - The ignore rules come from the base's policy, like every other criterion. A candidate that edits them gets `POLICY_CHANGED`, and coverage is still computed with the base's rules, so the edit can't remove an obligation.
  - A file mapped to a claim is a coverage declaration, not proof that every changed behavior was exercised.
- **Missing claims.** A required claim with no result, because the run stopped, crashed or ran out of budget, is written as `NOT_VERIFIED` with `NOT_RUN`. A missing result never counts as a pass.
- **Exit codes**, in order of precedence (decision 6):
  - **1** when at least one new failure or regression is established, even if other checks are incomplete. That's a claim `FAILED` with `NEW_FAILURE`, or a new suspected defect.
  - **0** when every required claim is VERIFIED and nothing blocks the verdict.
  - **2** otherwise: verification incomplete, unstable or not comparable, or blocked by pre-existing failures, without an established new regression.
  - A timeout is never a regression by itself. A check that fails on both revisions stays failed. Without finer evidence, the report doesn't claim it's the same failure on both.

### Examples

**Passing checks with uncovered behavior.** The project checks pass, but the behavior the change touches has no approved expectation:

```json
{
  "verdict": "NOT_VERIFIED",
  "exitCode": 2,
  "claims": [
    {
      "id": "project/unit-tests",
      "kind": "project-check",
      "outcome": "VERIFIED",
      "reason": "PASSED",
      "execution": {
        "status": "completed",
        "attempts": [
          { "side": "candidate", "n": 1, "exitCode": 0, "durationMs": 41200, "log": "candidate/unit-tests/attempt-1.log" }
        ]
      },
      "baseline": { "status": "completed", "result": "passed", "comparison": "STILL_PASSING" },
      "gaps": ["The suite's own coverage; no per-test results were collected"]
    },
    {
      "id": "behavior/sync-partial-failure",
      "kind": "behavior",
      "outcome": "NOT_VERIFIED",
      "reason": "EXPECTATION_MISSING",
      "execution": { "status": "skipped", "attempts": [] },
      "gaps": ["Registry question: When a sync fails halfway through, should the list keep the items that already synced?"]
    }
  ],
  "coverage": { "uncovered": ["src/theme.js"] }
}
```

**A new regression.** The suite passes on the base and fails on the candidate:

```json
{
  "id": "project/unit-tests",
  "outcome": "FAILED",
  "reason": "NEW_FAILURE",
  "execution": {
    "status": "completed",
    "attempts": [{ "side": "candidate", "n": 1, "exitCode": 1, "durationMs": 39800, "log": "candidate/unit-tests/attempt-1.log" }]
  },
  "baseline": { "status": "completed", "result": "passed", "comparison": "NEW_FAILURE" }
}
```

The run's `exitCode` is 1.

**A pre-existing failure.** Lint fails on both sides:

```json
{
  "id": "project/lint",
  "outcome": "FAILED",
  "reason": "FAILING_ON_BOTH",
  "baseline": { "status": "completed", "result": "failed", "comparison": "FAILING_ON_BOTH" },
  "gaps": ["Command-level result: a new lint error could hide among the existing ones; no per-rule results were collected"]
}
```

Not a pass. The run's `exitCode` is 2, because no new failure is proven.

**An untriggered fault.** The failure-path check completed, but its fault never fired:

```json
{
  "id": "behavior/items-keep-content",
  "outcome": "NOT_VERIFIED",
  "reason": "FAULT_NOT_TRIGGERED",
  "execution": { "status": "completed", "attempts": [{ "side": "candidate", "n": 1, "report": "candidate/items-keep-content/failure-1/report.json" }] },
  "gaps": ["FAULT_NOT_TRIGGERED: the failure path was not exercised"]
}
```

**A timeout with partial evidence.** Discovery stopped at its budget:

```json
{
  "id": "behavior/files-list",
  "outcome": "NOT_VERIFIED",
  "reason": "BUDGET_EXHAUSTED",
  "execution": {
    "status": "budget-exhausted",
    "attempts": [{ "side": "candidate", "n": 1, "report": "candidate/files-list/failure-1/report.json", "completedExperiments": 3, "plannedExperiments": 5 }]
  },
  "evidence": [{ "path": "candidate/files-list/failure-1/report.json", "sha256": "a91f…" }],
  "gaps": ["BUDGET_EXHAUSTED: rejection-every-read and rejection-1-call2 were not run"]
}
```

The other claims' results are kept. `run.status` is `budget-exhausted`.

**A changed expectation that needs renewed approval.**

```json
{
  "id": "behavior/items-keep-content",
  "outcome": "NOT_VERIFIED",
  "reason": "EXPECTATION_CHANGED",
  "expectation": {
    "approvedVersion": "sha256:7d1c…",
    "candidateVersion": "sha256:c044…",
    "changedInputs": ["checks/items-steps.json"],
    "approved": false
  },
  "execution": { "status": "completed", "attempts": [{ "side": "candidate", "n": 1, "against": "approvedVersion", "report": "…" }] },
  "gaps": ["The candidate changes this claim's expectation; it needs approval on the base before it can verify anything"]
}
```

### Review signals

Some test changes can weaken verification, but they can also be legitimate. The report lists them under `reviewSignals`, read from the changed-file list the planner already computes (`changesSince`):

- `TEST_FILE_DELETED`
- `TEST_FILE_CHANGED`
- `CHECK_INPUT_CHANGED`

They're leads for review. They aren't failures, and they don't affect the verdict, except check inputs, which do because they're criteria. Finer detection (removed assertions, added `skip`, new mocks) is deferred.

## 5. Command detection, approval and isolation

### Detection proposes; it never runs

`recovery-probe verify --propose-checks` (and the same in `plan_verification`) reads project configuration and prints candidate commands, each with the evidence for it. It never executes anything.

| Looks at | Proposes |
| --- | --- |
| `tsconfig.json` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` |
| ESLint configuration files | `node node_modules/eslint/bin/eslint.js .` |
| `package.json` `scripts` | Each script whose name or body names a type checker, linter or test runner. The script text is quoted as evidence. |
| Test runner configuration (`vitest.config.*`, `jest.config.*`, `playwright.config.*`) and `node --test` in scripts | the runner's direct invocation |
| Lockfiles | the package manager for `setup` |

Ambiguity is reported, never resolved by guessing:
- several test scripts;
- a script that chains commands with `&&` or pipes, which `shell: false` can't run;
- a script that starts servers;
- a configuration that needs environment variables.

The output is a proposal. A person copies the commands they approve into the policy, and they become approved through review on the base.

### Execution

The runner reuses repair's process code, moved to a shared module so verify and repair use one implementation:

- **Argument arrays only**, through `validateCommand`, with `shell: false`.
- **An allowlisted environment**: `executionEnvironment`. The policy can add variable names, never values from the agent's environment. The report records the names passed, never the values.
- **A timeout per command, and process-tree stop**: `startCommand` and `stopTree`. Abort signals are added (section 7).
- **Full logs.** Output is written to a log file for each attempt, with no truncation. The report keeps a hash and the last lines.

### Isolation per side

- **Base.** A disposable clone of the base commit, using repair's method: `clone --local --no-hardlinks --no-checkout`, a detached checkout, `origin` removed, Git hooks disabled.
- **Candidate.** A snapshot commit of the working tree, made without touching the user's index or branch: a temporary index, `git add -A`, `git write-tree`, `git commit-tree`. It's then cloned the same way.
  - Ignored files such as `.env` aren't included.
  - The report records the snapshot's tree hash and `HEAD`.
- **Dependencies.** The policy's `setup` runs in each checkout.
  - Each side's lockfile hash is recorded, and a difference shows in the report.
  - Package caches outside the checkout are shared and read-only by intent. That's a recorded limitation, not a guarantee.
- **Contamination.** `assertTrackedUnchanged` runs after each command. A command that changed tracked files adds `CHECK_MODIFIED_TRACKED_FILES` to its claim.
- **Order.** Sides and checks run one at a time by default, so servers and ports don't collide.
- **Cleanup.**
  - Run folders live outside the repository, as for repair. Each attempt's logs and reports are copied into `.recovery-probe/verify/<run>/`, which Git ignores.
  - Checkouts are removed after the run unless `--keep-checkouts` is given.
  - Process trees are stopped when commands and apps finish.

A checkout is not a security sandbox. Approved commands and the candidate's code run with the user's permissions, and can read and write files and reach the network. For code nobody has reviewed, run verify in a disposable VM or container. Use test accounts and non-production services only, and no real credentials. A destructive command doesn't belong in a policy.

## 6. Base-versus-candidate comparability

A claim's base and candidate results are compared only when all of these hold:

- the same approved command or scenario, from the same policy identity;
- the same environment fingerprint: Node version, platform, package manager version and environment names;
- both sides completed: neither timed out, was cancelled or failed to start;
- for behavioral claims, the conditions `compare` already applies: the same workflow, transport and target ([compare.md](../compare.md#run-it)).

When one fails, the comparison is `NOT_COMPARABLE`, with the reason. Different lockfiles don't block a comparison: they're part of the change, and the report shows the difference.

**Project checks, at command level:**

| Base | Candidate | Comparison | Claim outcome |
| --- | --- | --- | --- |
| passed | passed | `STILL_PASSING` | VERIFIED |
| passed | failed | `NEW_FAILURE` | FAILED, exit 1 |
| failed | failed | `FAILING_ON_BOTH` | FAILED, exit 2. A new failure can hide among the old ones. |
| failed | passed | `RESOLVED_FAILURE` | VERIFIED |
| not completed | passed | `NOT_COMPARABLE` | VERIFIED on the candidate. The base's status shows as a gap. |
| not completed | failed | `NOT_COMPARABLE` | FAILED, exit 2. The failure isn't proven new. |
| any | not completed | `NOT_COMPARABLE` | NOT_VERIFIED |

A pre-existing failure stays a failure. Telling a new test failure apart from an old one needs per-test results from the runner, such as a JUnit XML file named in the policy. That's deferred (section 10). Until then, `FAILING_ON_BOTH` says what can't be told.

**Behavioral claims** use `compareRuns`. The normal path and the failure path must each pass the aggregation rules, with every assertion met and no defect problem. The comparison then says whether the change fixed the claim (`IMPROVED` from a failing base), kept it (`UNCHANGED` and clean), or broke it (`REGRESSED`, with exit 1 for a new suspected defect, as `compare` decides).

**Flakiness.** All attempts are kept.
- A failure followed by a pass is `UNSTABLE`: an observed instability, not proof of its cause.
- Verify never retries until green.
- `attempts` in the policy, 1 to 3, sets how many runs a project check gets. Scenario runs keep verify's `runs` (1 to 10).
- When a runner retries by itself, only its final exit is visible, unless per-test results are collected. The report says so.

## 7. Budgets, cancellation and partial results

### Budgets

Approved defaults (decision 4):

| Budget | Default | Where |
| --- | --- | --- |
| Overall | 30 minutes | `budgets.totalMs` |
| Each scenario run | 5 minutes | `budgets.scenarioRunMs` |
| Each project check | explicit, required | `projectChecks[].timeoutMs`: a policy without one is invalid |
| Cleanup | reserved inside the overall budget | `budgets.cleanupReserveMs` |

- **Overrides.** `--budget` on the CLI and `budgetMs` on `verify_change` can lower a budget, never raise it. Raising one means changing the approved policy.
- **Verification always supplies a limit.** Every scenario run that verify starts gets one, including discovery's `maxDurationMs`.
- **The budget counts everything:** setup, app launch and readiness waits, every attempt and retry, and cleanup.
- **Estimates come first.** Each operation has a worst-case duration, from its timeouts and attempts. Verify prints the total before it starts, and orders the work:
  1. the policy identity and the suspect scan;
  2. project checks;
  3. behavioral claims.

  Work that can't fit is reported up front as `budget-exhausted`, NOT_VERIFIED. Nothing is started that can't finish in the remaining budget.
- **Estimates never replace enforced deadlines.** Every operation runs under its deadline, and a deadline that passes stops it even when its estimate said it would fit.
- **Cleanup has reserved time, and its outcome is reported as it happened.** Cleanup means removing faults, stopping processes and a final reload. When it fails or runs out of time, the report says so, and never states that a healthy final reload succeeded unless one did.
- **Discovery's estimate.** Discovery computes its worst case from its own configuration: calibration loads × `baselineTimeoutMs`, plus each experiment's control and faulted loads and the every-read run. It prints the result at the start, and records it as `estimate.plannedLoads` and `estimate.worstCaseMs`.

### Discovery: `maxDurationMs`

`maxDurationMs` is a new optional configuration field for discovery. Without it, standalone discovery behaves as today.

- **Before each experiment**, discovery checks its worst case against the time left before the cleanup reserve. It doesn't start an experiment that can't fit.
- **The deadline is also enforced while loads run.** If a load overruns, the experiment in progress stops and is reported as incomplete, and the run goes to cleanup.
- **When the budget runs out**, the report records `stoppedReason: "BUDGET_EXHAUSTED"`.
  - Completed experiments keep their findings, and the rest are listed as not run.
  - The evidence gets `complete: false` with the gap `BUDGET_EXHAUSTED`.
- **Cleanup runs from the reserved time:** the faults are removed, then the final reload. Its outcome is recorded as it happened: healthy, not healthy, or not attempted for lack of time.
- **Verify** and `verify_change` pass `min(scenarioRunMs, remaining budget)` as the run's `maxDurationMs`.

### Cancellation

This builds on what exists:

1. **MCP.** `notifications/cancelled` already aborts the tool's `AbortController` (`server.mts:142`).
   - `verify_change` and `self_check_scenarios` will pass `signal` into `verifyChange` and self-check.
   - `run_recovery_probe` will use the same graceful stop as verify.
2. **Verify and the check runner.** `runRecoveryProbe` and `runCheck` gain `{ signal, timeoutMs }`.
   - A stop is graceful first: the child CLI gets a stop request over an IPC channel or stdin, because on Windows `SIGTERM` ends a process without running its handlers.
   - After a grace period, 10 s by default, `stopTree` ends the process tree.
3. **CLI commands.** `discover`, `check`, `action` and `verify` get the `AbortController` handling `observe` and `refresh` already have (`cli/observe.mts:155-187`, `cli/refresh.mts:31-44`). On SIGINT, SIGTERM or a stop request they:
   - stop at the next safe point;
   - run their existing cleanup in `finally`: removing routes, resetting the IPC hook, the final reload;
   - write the report with what completed.
4. **The IPC hook's fault TTL stays** as the last safeguard when a process is killed outright.

### Durable partial results

- **Discovery** writes `report.partial.json` and `progress.json` after each experiment, atomically (a temporary file, then a rename).
  - `progress.json` holds the phase, completed and planned loads, elapsed time and worst-case remaining time. An agent can read it instead of sleeping.
  - `report.json` stays the final report, so readers that look for it don't see a run in progress.
- **Runs killed outright.** `runCheck` falls back to `report.partial.json` when no `report.json` exists. It reads it with `complete: false` and the gap `PROCESS_STOPPED`, so partial evidence is kept and can never read as a fix.
- **Verify** writes `verification.partial.json` after every attempt, and the final `summary.json` in `finally`, including after a cancel or a budget stop.
  - Today each side's folder is deleted before its new runs start (`verify.mts:110`), so an interrupted baseline loses the previous one.
  - Instead, new runs go to a fresh folder that replaces the old one only when the side finishes.
- **MCP.** A cancelled call gets no reply, as today. The results stay on disk, and `verify_change` with `status: true` returns the last partial or final summary without running anything.

## 8. Compatibility and migration

The [1.x commitment](../../README.md#compatibility-in-1x) covers documented, non-experimental CLI commands and options, exit codes, configuration fields, MCP tools and JSON report fields. Verify isn't marked experimental, so it's covered. The planner, self-check and repair are experimental.

Decisions:

- **No new plan keys.** `verifyPlan` rejects unknown keys (`verify.mts:42-43`), so older versions would reject a newer plan. Policy is a separate file.
- **Policy mode is opt-in and experimental.** It's enabled with `--policy FILE` on the CLI and `policy` on `verify_change`. Without them, verify behaves exactly as today. Its verdict, reasons and exit codes stay the same.
- **New inputs are optional and additive:**
  - on the CLI: `--policy`, `--base`, `--budget`, `--propose-checks` and `--keep-checkouts`;
  - on `verify_change`: `policy`, `base`, `budgetMs` and `status`.
- **`summary.json` additions are additive.**
  - Without a policy, `claims` are derived from the plan's checks, with expectation source `plan`, unapproved, so the shape is the same in both modes.
  - The new top-level fields, and `claims[].outcome`, sit beside today's fields. None is renamed or retyped.
- **The evidence block stays `recovery-probe/evidence@1`.** New gap codes (`BUDGET_EXHAUSTED`, `PROCESS_STOPPED`) appear in `gaps` as text, which readers already treat as incomplete.
- **Discovery's report gains optional fields:** `estimate`, and a report-level `stoppedReason` next to the existing per-experiment one. Its exit codes don't change.
- **`run_recovery_probe` keeps `timeoutMs`.** It only stops processes more completely.
- **Exit codes keep their meaning**: 1 only for a new failure or defect.
- **Stabilizing policy mode takes evidence, not a release count** (decision 8). It stays opt-in and experimental until all of these support it:
  - compatibility tests;
  - cancellation and process-cleanup tests;
  - trust-boundary tests;
  - the pilot (section 9).

  A passing pilot alone isn't enough while reliability problems remain. Stabilization needs an explicit review, and nothing promotes it automatically after a number of releases.

No migration is needed for existing plans, baselines or reports. Policy mode runs its own base side in a checkout, so it doesn't reuse a baseline recorded by hand.

## 9. Pilot benchmark protocol

The goal is to learn whether orchestrated verification reduces unsupported "done" claims and missed defects enough to justify its time and setup cost, on code anyone can rerun.

### Selection rules, fixed before any run

- **Projects:** two (decision 7).
  - Each is public, open-source licensed, JavaScript or TypeScript, with a working type-check, lint or test setup, and a web UI that loads data with `fetch` or XHR, so HTTP failure paths apply.
  - Projects are chosen for reproducible historical bugs and feasible setup, not popularity.
  - No project is named until its candidate issues and commits have been checked.
- **Cases:** six, one per type below.
  - Each is a historical bug with an identifiable buggy commit and fixing commit, the buggy commit being the fix's parent.
  - Each needs a public issue that describes the symptom without naming the fix.
- **Approval comes first.** The owner approves the selected cases and the execution budget before any paid run.

| Case type | Expected outcome, kept outside the agent's workspace |
| --- | --- |
| A bug the project's tests can catch | correct fix → VERIFIED; an incomplete fix → FAILED |
| A user-visible failure-handling bug, such as a failed read shown as empty | needs the behavioral claim; correct fix → VERIFIED |
| An intended behavior change that legitimately edits a test | the test edit shows as a review signal, the changed expectation is flagged for approval, no false failure |
| A change whose expected behavior isn't specified (a missing expectation) | NOT_VERIFIED with the question; the agent asks instead of inventing |
| A change outside every claim | uncovered files listed; never called verified |
| A base that already fails a check | `FAILING_ON_BOTH`, never a pass |

- **Expected outcomes and the fixing commits** stay in a private grading folder. The agent's prompt is the issue text, rewritten only to remove references to the fix, and the buggy checkout.

### Phase 1: the verifier alone, deterministic

Before any agent runs, feed fixed candidate patches through verify: the real fix, a known-bad patch, a patch that weakens a test, and a scenario whose fault can't trigger. Score them against the expected outcomes. This measures the verifier's rules, not agents, and must pass before phase 2.

### Phase 2: agents

- **Arm A:** the agent is told to run the project's checks and the relevant application and failure-path checks before saying it's done. The exact approved commands and the claim's text and assertions are given as plain text, with Playwright available.
- **Arm B:** the same agent, model, effort, settings, time budget, task text and tools, plus the Recovery Probe MCP server and the same commands and claims as a policy file.
- **Extra information.** Anything B gets that A doesn't, such as estimates, progress and report contents, is logged and reported separately. The policy carries no information A's text lacks.
- **Size and limits:**
  - three repetitions per case and arm, in a seeded random order: 36 agent sessions;
  - each session is limited to 30 minutes;
  - a total agent-cost ceiling of US$50 is proposed, covering grading and failed runs.

  The ceiling is for planning. It doesn't authorize spending money or using credentials.
- **Every run is preserved**, including timeouts and failed setups.
- **Grading:**
  - deterministic checks wherever possible: the fixing commit's tests and the claim's checks, run on the agent's final code;
  - claims are classified by a separate grader, blind to the arm;
  - the owner reviews disputed judgments;
  - grading that can't be completed is recorded as incomplete, never forced into a class.

### Measures

- defects missed before the agent claimed completion;
- incorrect defect claims;
- unsupported "done" claims: done claimed while the ground truth fails, or while a required claim is unverified;
- wall time, and complete cost accounting, with every attempt counted and a missing estimate reported as missing, never as zero;
- initial setup effort: the time to write each project's policy, measured once;
- ongoing maintenance: the policy changes needed across the next 20 commits of each project, replayed;
- incomplete runs and timeouts, split into those caused by Recovery Probe and the rest.

### Decision criteria, fixed before any run

These are practical judgements set before any data exists. Once the owner approves this protocol, they won't be revised after seeing results.

- **Continue and broaden** if all of these hold:
  - B has at most half of A's unsupported "done" claims, and at least three fewer in absolute terms;
  - B misses no more defects than A, and makes no more incorrect defect claims;
  - B's median wall time is at most 1.5 times A's;
  - Recovery Probe causes at most one incomplete run in the pilot.
- **Inconclusive: don't broaden yet** when the differences are too small to support either broadening or stopping. Small differences don't prove the tool has no value. This is the expected outcome for a small pilot unless the effects are large.
- **Stop** if any of these holds. They're about cost and reliability, not small differences:
  - B's median wall time is more than twice A's;
  - writing a policy takes more than two hours per project;
  - Recovery Probe causes incomplete runs in more than one case.
- **Components can't be told apart.** A two-arm comparison can't show which part of Recovery Probe caused an advantage. Dropping project-check orchestration, or any other component, needs a separate component comparison first.

With six cases and three repetitions, results are descriptive. The report will say so and list every limitation, as the earlier study did.

## 10. Implementation sequence

Each PR is reviewable on its own and leaves the package releasable.

1. **Bounded discovery with progress and durable partial results.** This is gap G7, the confirmed cause of the study's timeout pattern.
   - the worst-case estimate;
   - `maxDurationMs`: a check before each experiment, a deadline enforced during loads, `BUDGET_EXHAUSTED`, and reserved cleanup whose outcome is reported as it happened;
   - SIGINT and SIGTERM handling that runs cleanup and writes the report;
   - `report.partial.json` and `progress.json` after each experiment.
2. **Bounded, cancellable check runs (G6, G8).**
   - `runRecoveryProbe` and `runCheck` with `signal`, a timeout, graceful stop, then a tree stop;
   - `verify_change` and `self_check_scenarios` honor the MCP signal;
   - `run_recovery_probe` stops process trees;
   - `runCheck` reads partial reports.
   - Repair's process code moves to a shared module, unchanged in behavior.
3. **The claim report and approved-policy identity (G4, G5).** No new kinds of execution.
   - claims derived from today's checks and the suspect scan;
   - the aggregation rules as a pure function;
   - revisions and the candidate snapshot hash;
   - `--policy`, reading the policy and its inputs from the base, with hashes;
   - `EXPECTATION_CHANGED`, `POLICY_CHANGED` and `CHECK_INPUT_CHANGED`;
   - incremental `verification.partial.json`.
4. **Vertical slice: one approved behavioral claim, end to end (G3, scenario part).** One claim on the planner's synthetic app:
   - a normal-path `observe` with `expect` steps, and the failure-path check;
   - the app launched per side from base and candidate checkouts, reusing repair's launch code;
   - approved check files copied from the base;
   - an evaluation, `eval:verifier`, covering a fix, a regression, an untriggered fault, a missing expectation, a changed expectation and a budget stop.
5. **Approved project checks, base versus candidate (G1, G2, G9).**
   - `--propose-checks`, which never executes;
   - `setup` and project checks in disposable checkouts;
   - attempts, full logs, contamination checks, and the comparison table in section 6.
6. **Pilot harness and protocol.**
   - `evaluations/verifier-pilot/PROTOCOL.md` with the selection rules, cases and decision criteria above;
   - a harness that keeps expected outcomes outside agent workspaces.

   No results are published until both phases have run.

**Deferred:**
- per-test results from JUnit XML;
- finer review signals: removed assertions, added `skip`, new mocks;
- MCP progress notifications;
- launching Electron apps per side;
- detecting a policy without `--policy`.

## 11. Acceptance criteria and tests

| PR | Accepted when | Tests that matter |
| --- | --- | --- |
| 1 | A discovery run with `maxDurationMs` stops before an experiment that wouldn't fit, and stops a load that overruns the deadline. It keeps every completed experiment, removes its faults, reports the final reload as it happened, and exits 2 with `BUDGET_EXHAUSTED`. SIGTERM mid-run writes `report.json` with what completed. `progress.json` and the estimate match the configuration. Runs without the new field behave as before. | Unit: estimate arithmetic for HTTP, IPC and later-call experiments; the scheduler refusing an experiment over budget; a cleanup that fails or runs out of time is never reported healthy. Integration on the existing discovery fixtures: a small budget gives `INCOMPLETE` with N of M experiments and clean routes or hook state; SIGTERM leaves the report and no armed fault; `compare` treats the partial run as incomplete. |
| 2 | A hung check is stopped at its timeout, with its whole process tree, on Windows and POSIX. Cancelling `verify_change` stops its children. A killed run's partial report is kept as incomplete evidence. Existing verify results are unchanged. | A fake CLI that spawns a grandchild and sleeps: after the timeout neither process exists, and the result is `timed-out` with output kept. MCP cancel during `verify_change` ends the children (extending `test/unit/mcp.test.mjs` "cancels a running tool"). A partial report gives `complete: false` with `PROCESS_STOPPED`. Every existing `test/unit/verify.test.mjs` case passes unchanged. |
| 3 | Without a policy, `summary.json` keeps its current fields, values and exit codes, and gains `claims`. With a policy, criteria come from the base: editing an `expect` step, the policy or a named input in the candidate gives NOT_VERIFIED with both hashes. A missing claim result is never a pass. | Table-driven tests of every aggregation rule, including empty and missing evidence. A golden test of the old fields against today's output. A fixture repository where the candidate edits a step file: the copied base file is the one that runs, and the claim reads `EXPECTATION_CHANGED`. Hashes use committed bytes, so line endings don't change them. |
| 4 | One claim gives each expected result on the synthetic app: VERIFIED for the fix, FAILED (exit 1) for a regression, NOT_VERIFIED for a fault that doesn't trigger, a missing expectation, a changed expectation and a budget stop. Base and candidate are launched from their own checkouts, and their commits are recorded. | `npm run eval:verifier` against an `expected.json` the tool never reads, with each case's verdict, reason and exit code. A port already in use is refused. The app is stopped after each side. |
| 5 | Proposals come with evidence and never execute. Approved commands run with an allowlisted environment, in disposable checkouts. The comparison table holds. A command that changes tracked files is flagged. | A spy proves detection runs nothing. A fixture repository with plain Node scripts covers: a new failure gives exit 1; failing on both gives FAILED and exit 2, never a pass; a resolved failure; fail-then-pass gives `UNSTABLE` with both attempts kept; a timeout leaves the other checks' evidence intact; a secret in the parent environment doesn't reach the command; a log over 32000 characters is kept whole. |
| 6 | The protocol is merged before any agent run. Expected outcomes are unreachable from agent workspaces. | A harness self-test proves the expected outcomes are outside the workspace and the deny list, and that every attempt, including failed setups, is written to disk. |

## 12. Decisions

The owner decided these on 2026-11-20. The sections above follow them.

1. **Expectation approval comes from the base revision only** (section 3).
   - There's no acceptance flag and no approvals file in the candidate.
   - An expectation changed in a pull request stays NOT_VERIFIED until it's reviewed and merged, and its result against the old expectation is still shown.
   - The base's provenance is recorded on its own. Matching `origin/main` proves neither branch protection nor human approval, and the report describes local trust honestly. CI supplies the trusted base commit.
2. **The policy lives in `recovery-probe.policy.json`**, separate from the registry (section 4). The policy owns approved commands, budgets and required claims. The registry owns scenario definitions, which claims reference by stable ID.
3. **Coverage is strict in policy mode** (section 4).
   - Uncovered changed files outside the base's ignore rules block the overall VERIFIED, and each is listed.
   - Covered claims can still be VERIFIED.
   - File mapping is a coverage declaration, not proof of exercise. Candidate changes to the ignore rules don't remove coverage obligations.
4. **Budgets** (section 7):
   - the defaults: 30 minutes overall, 5 minutes per scenario run, and an explicit timeout for each project check;
   - overrides can only lower them;
   - standalone discovery is unchanged without `maxDurationMs`, while verification always supplies a limit;
   - setup, launch and retries count, and cleanup is reserved inside the overall limit;
   - estimates never replace enforced deadlines, and a failed cleanup is reported as failed.
5. **App launching is web first** (section 4): disposable checkouts, explicit readiness checks, approved fixtures, owned processes, occupied ports refused, and processes stopped after each side.
   - Automatic Electron launching is deferred, and existing Electron functionality is preserved.
   - A manually attached app with an unknown source revision can't produce a verified revision-specific claim.
6. **Exit codes keep 0, 1 and 2, with explicit precedence** (section 4).
   - 1 for any established new failure or regression, even with other checks incomplete.
   - 0 when every required claim is verified with no blocking gap.
   - 2 otherwise.
   - A timeout isn't a regression. A failure on both revisions stays failed, without a claim that it's the same failure.
7. **The pilot starts small** (section 9):
   - two projects, six cases, three repetitions per case and arm: 36 sessions;
   - the same model and settings in both arms, a 30-minute session limit, and a proposed US$50 cost ceiling covering grading and failed runs;
   - the owner approves cases and budget before any paid run;
   - the decision rules include "inconclusive: don't broaden yet", and component attribution needs its own comparison.
8. **Stabilization is evidence-based** (section 8): compatibility, cancellation and cleanup, trust-boundary tests, and the pilot, followed by an explicit review. A release count never promotes it.

Still open:
- trusted approval before merge;
- automatic Electron launching;
- the pilot's specific cases and execution budget, which the owner approves before any run.
