# Verifier pilot: protocol

This protocol is fixed before any agent run, as the [verifier design](../../docs/architecture/verifier-design.md#9-pilot-benchmark-protocol) requires. It decides how cases are chosen, how the two arms run, how they're graded, and what the results will be allowed to conclude. No results are published until both phases have run.

## The question

Does orchestrated verification, Recovery Probe's policy mode, reduce unsupported "done" claims and missed defects enough to justify its time and setup cost, on code anyone can rerun?

## Size and limits

- **Projects:** two.
- **Cases:** six, one per case type.
- **Sessions:** three repetitions per case and arm, in a seeded random order: 36 agent sessions.
- **Time:** each session is limited to 30 minutes.
- **Cost:** the proposed ceiling is US$50 in total, covering agent sessions, grading and failed runs.
- **Approval comes first.** The owner approves the selected cases and the execution budget before any paid run. The ceiling is for planning; it doesn't authorize spending money or using credentials. The harness refuses to run agents without the owner's approval file.

## Selection rules

**Projects:**

- public, under an open-source license, JavaScript or TypeScript;
- a working type-check, lint or test setup;
- a web UI that loads data with `fetch` or XHR, so HTTP failure paths apply.

Projects are chosen for reproducible historical bugs and a feasible setup, not popularity. No project is named, in this repository or elsewhere, until its candidate issues and commits have been checked.

**Cases:**

- each a historical bug with an identifiable buggy commit and fixing commit, the buggy commit being the fix's parent;
- each with a public issue that describes the symptom without naming the fix.

| Case type | `type` in case.json | Expected outcome |
| --- | --- | --- |
| A bug the project's tests can catch | `tests-catch` | correct fix → VERIFIED; an incomplete fix → FAILED |
| A user-visible failure-handling bug, such as a failed read shown as empty | `failure-handling` | needs the behavioral claim; correct fix → VERIFIED |
| An intended behavior change that legitimately edits a test | `intended-change` | the test edit shows as a review signal, the changed expectation is flagged for approval, no false failure |
| A change whose expected behavior isn't specified | `missing-expectation` | NOT_VERIFIED with the question; the agent asks instead of inventing |
| A change outside every claim | `outside-claims` | uncovered files listed; never called verified |
| A base that already fails a check | `base-fails` | `FAILING_ON_BOTH`, never a pass |

## What agents never see

Expected outcomes, fixing commits and grading notes stay in a **private grading folder**:
- outside this repository;
- outside every agent workspace;
- on every session's denied-read list.

The agent gets the issue text, rewritten only to remove references to the fix, and a checkout of the buggy commit with its arm's materials. The harness refuses a grading folder inside the repository, and a workspace inside the grading folder or the other way round.

## Phase 1: the verifier alone

Before any agent runs, fixed candidate patches go through `verify` with each case's policy:
- the real fix;
- a known-bad patch;
- a patch that weakens a test;
- a scenario whose fault can't trigger.

The harness scores each patch against its expected verdict, exit code and claim reasons. This measures the verifier's rules, not agents. It must pass before phase 2 starts.

## Phase 2: agents

- **Arm A:** the agent is told to run the project's checks and the relevant application and failure-path checks before saying it's done. The approved commands and each claim's text and assertions are given as plain text, with Playwright available.
- **Arm B:** the same agent, model, effort, settings, time budget, task text and tools, plus the Recovery Probe MCP server, and the same commands and claims as a policy file.
- **No extra information.** The policy carries no information arm A's text lacks. Anything arm B gets that arm A doesn't, such as time estimates, progress and report contents, is logged and reported separately.
- **The same starting point.** Each session gets a fresh workspace: the buggy commit plus its arm's materials, committed as the pilot base and pushed to a local remote, so `verify --base main` reads the approved policy.
- **Every session is preserved:** its record, its full transcript and its final diff, including timeouts and failed setups.

## Grading

- **Deterministic checks wherever possible:** the fixing commit's tests and the claim's checks, run on the agent's final code.
- **Classification:** a separate grader, blind to the arm, classifies each agent's claims.
- **Disputes:** the owner reviews disputed judgments.
- **Incomplete grading** is recorded as incomplete, never forced into a class.

## Measures

- defects missed before the agent claimed completion;
- incorrect defect claims;
- unsupported "done" claims: done claimed while the ground truth fails, or while a required claim is unverified;
- wall time, and complete cost accounting, with every attempt counted and a missing estimate reported as missing, never as zero;
- initial setup effort: the time to write each project's policy, measured once;
- ongoing maintenance: the policy changes needed across the next 20 commits of each project, replayed;
- incomplete runs and timeouts, split into those caused by Recovery Probe and the rest.

## Decision criteria

These are set before any data exists. Once the owner approves this protocol, they won't be revised after seeing results.

- **Continue and broaden** if all of these hold:
  - B has at most half of A's unsupported "done" claims, and at least three fewer in absolute terms;
  - B misses no more defects than A, and makes no more incorrect defect claims;
  - B's median wall time is at most 1.5 times A's;
  - Recovery Probe causes at most one incomplete run in the pilot.
- **Inconclusive: don't broaden yet** when the differences are too small to support either broadening or stopping. Small differences don't prove the tool has no value. This is the expected outcome for a small pilot unless the effects are large.
- **Stop** if any of these holds:
  - B's median wall time is more than twice A's;
  - writing a policy takes more than two hours per project;
  - Recovery Probe causes incomplete runs in more than one case.
- **Components can't be told apart.** A two-arm comparison can't show which part of Recovery Probe caused an advantage. Dropping a component needs a separate component comparison first.

With six cases and three repetitions, the results are descriptive. The report will say so and list every limitation.

## Running it

See [README.md](README.md) for the grading folder's layout and the harness's commands.
