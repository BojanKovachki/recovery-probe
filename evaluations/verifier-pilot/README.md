# Verifier pilot: harness

The harness for the pilot that [PROTOCOL.md](PROTOCOL.md) defines. It holds no cases and no results: those live in a private grading folder that never enters this repository. Nothing here runs an agent without the owner's approval.

## The grading folder

A folder outside this repository; the harness refuses one inside it. Agents never get it: every session's settings deny reads of it.

```text
grading/
  approval.json              the owner's approval: { "cases": [ids], "budgetUsd": 50, "approvedBy", "at" }
  cases/<id>/
    case.json                { "type", "repository", "buggyCommit", "fixCommit", "expected", "environment" }
    ISSUE.md                 the agent's task: the issue, without references to the fix
    arm-a.md                 arm A: the approved commands, and each claim's text and assertions
    policy/                  arm B: recovery-probe.policy.json, its registry and check files
    common/                  optional, both arms: what running the app needs, such as a stand-in backend
    phase1.json              fixed patches and what verify should say about each
    phase1/<patch>           those patches
  runs/<run>/
    phase1.json              phase 1's scores
    phase1/<case>/<patch>/   verify's output (verify.log) and records (verify/) for each fixed patch
    <session>/attempt.json   every session's record: setup failures and timeouts included
    <session>/transcript.log the agent's full output
    <session>/diff.patch     everything the agent changed from the pilot base
```

- `type` is one of `tests-catch`, `failure-handling`, `intended-change`, `missing-expectation`, `outside-claims` or `base-fails`, as in the protocol.
- `repository` is a clone URL or a local path. `buggyCommit` is the fix's parent, as a full commit id: GitHub fetches a commit by its full id only.
- `environment` is optional: `path` lists absolute folders put ahead of `PATH`, such as the Node version the project needs, and `variables` sets variables such as `TZ`. The agent's session and phase 1's verify both get them, so both arms run the same tools with the same settings. A policy whose project checks need a variable names it in `env`.
- Each `phase1.json` entry is `{ "patch": "real-fix.patch", "expected": { "verdict", "exitCode", "reasons": { "<claim id>": "<reason>" } } }`.

## A session

1. A fresh folder under the system's temporary folder, outside this repository and the grading folder. The harness refuses either containing the other.
2. The workspace fetches `buggyCommit` and its history from `repository`, without tags: a clone would bring the fix and every later commit, which the agent could read with `git log --all`. Files are checked out with their committed line endings, as in Recovery Probe's own checkouts, so a line-ending lint rule fails in neither arm. Long paths are allowed, and a checkout that leaves any file different from the commit, such as one whose full path Windows couldn't create, is refused rather than committed as the pilot base. It adds `common/`, if the case has one, and the arm's materials: `VERIFY.md` for A, the policy files for B. It commits them as the pilot base and pushes that to a local remote as `main`, so `verify --base main` reads the approved policy.
3. The agent runs in the workspace, with the command in [pilot.json](pilot.json). It gets an allowlisted environment plus the case's `environment`, reads denied in the grading folder, this repository and the harness's own files, and no MCP server for A or Recovery Probe's for B. It's stopped at the session's time limit.
4. The record, the full transcript and the final diff go to the grading folder, and the session's folder is removed.

## Commands

```bash
npm run build
node evaluations/verifier-pilot/harness/pilot.mjs plan --grading ../grading
node evaluations/verifier-pilot/harness/pilot.mjs phase1 --grading ../grading --run pilot-1
node evaluations/verifier-pilot/harness/pilot.mjs run --grading ../grading --run pilot-1 --cli <claude> --model <model> [--limit N]
```

`run` refuses without `approval.json` naming every case, with a budget above zero and at most the ceiling in `pilot.json`. It also refuses before phase 1 has passed. It runs, in the seeded order, every session that has no finished record yet, so it can stop and resume. It stops when the recorded costs reach the approved budget, or when a session's cost is missing, since spending can't be tracked then.

`npm test` runs the harness's self-test (`test/unit/verifier-pilot.test.mjs`) on a synthetic project, with a stand-in for the agent. Nothing in it is paid for.
