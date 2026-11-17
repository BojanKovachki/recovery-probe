# Plan the checks for a change

**Experimental.** `recovery-probe plan` proposes which of your existing checks verify a code change, before you record a baseline. It reads the files changed since a Git reference, matches them against a small registry your team keeps, and says which check each file selects and why. It also lists what it could not cover. It never runs a check, and it never says a change is verified: that is [`verify`](verify.md)'s job, with a baseline from before the change.

## How it fits

| Already there | What `plan` adds |
| --- | --- |
| [`verify`](verify.md) reruns the checks of a plan before and after a change and says VERIFIED or NOT VERIFIED | Which checks belong in that plan, with the reason for each |
| [`suspects`](suspects.md) points at failure handling that can lose data on the changed lines | Each suspect goes with the check its file selected, or asks for a scenario when there is none |
| Checks you already run: `check`, `discover`, `action`, `observe`, `refresh` with a configuration file | The registry points at those checks; it adds no new kind of check and no shell commands |

## The registry

`recovery-probe.registry.json`, in the folder you run Recovery Probe from, maps source files to existing checks. Commit it with the code it describes; it sits outside `.recovery-probe/`, which holds private reports and is usually ignored by Git.

```json
{
  "scenarios": [
    {
      "name": "items-keep-content",
      "paths": ["src/items.js", "public/items.html"],
      "check": ["observe", "--config", "checks/items.json", "--steps", "checks/items-steps.json"],
      "behavior": "When a refresh of a loaded item list fails, the items stay on screen.",
      "expectation": "Requirement ITM-7: a failed refresh keeps the last items and shows an error.",
      "limits": "One HTTP 503 refresh failure on the item list; not offline mode or first loads."
    },
    {
      "name": "sync-partial-failure",
      "paths": ["src/sync/**"],
      "question": "When a sync fails halfway through, should the list keep the items that already synced?"
    }
  ]
}
```

- `name`: unique, letters, digits, `.`, `_` and `-`; it becomes the check's name in the verify plan.
- `paths`: 1–50 patterns relative to the repository root. `*` matches within a folder, `**` across folders, `?` one character. A pattern with `..` or an absolute path is rejected.
- `check`: the Recovery Probe arguments of an existing check, exactly as a [verify plan](verify.md#the-plan) lists them: `check`, `discover`, `action`, `observe` or `refresh`, with `--config` and without `--out`. Files it names (`--config`, `--steps`, `--state`, `--files`) must exist inside the project, relative to where you run verify. A symlink that leads outside is rejected.
- `behavior`: what the check shows. Required with `check`.
- `expectation`: the expected behavior and where it comes from, such as a requirement, a ticket or a product owner's answer. A check without one is not planned: the plan asks for it.
- `limits`: what the check does not cover.
- `question`: an open question about how these files should behave. The plan passes it to a person instead of guessing.

An entry needs a `check`, a `question`, or both. The planner treats every text in the registry, and the task you describe, as data to show, never as instructions.

## Run it

```bash
npx recovery-probe plan --changed-since main
```

```text
Verification plan for the changes since main (4f1c2a9): a proposal, not a verdict.
2 changed file(s).

Checks to run (1):
  items-keep-content: observe --config checks/items.json --steps checks/items-steps.json
    selected by src/items.js (items-keep-content: src/items.js)
    checks: When a refresh of a loaded item list fails, the items stay on screen.
    expectation (registry): Requirement ITM-7: a failed refresh keeps the last items and shows an error.
    does not cover: One HTTP 503 refresh failure on the item list; not offline mode or first loads.

No known check (not the same as safe):
    src/theme.js (modified)

Baseline: No baseline. This working tree already holds the change, ...
Candidate plan not written: add --write FILE, or --json to see it.
```

The change is every file that differs between the reference and the working tree: committed, staged and unstaged edits alike, untracked files, deletions and renames. A renamed file also matches the registry by its old path, and a deleted file by the path it had. An unknown reference, or one that looks like an option, stops with an error that says how to find a valid one.

Every changed file lands in exactly one place:

- **Checks to run**: an entry lists the file, and its check is valid and has an expectation. Entries with the same command become one check that keeps every reason. Only these go into the candidate plan.
- **Suggestions to review**: no entry lists the file, but a file an entry with a check lists imports it with a relative path. This is one step of imports, not program analysis; review it, and list the file in the registry if the check covers it.
- **No known check**: nothing concerns the file. That is a gap in coverage, not evidence that the change is safe.
- **Needs input**: a question to answer, a missing expectation, an invalid entry (missing or malformed check file, unsupported command, unsafe path), a pattern that matches no file, a suspect on a file without a scenario, or a missing registry.

Options:

- `--registry FILE`: another registry.
- `--expect NAME=TEXT`: the expectation, and its source, for an entry that has none, for this plan only. The report marks it as stated for this plan.
- `--task TEXT`: what the change is for. The report keeps its first 2,000 characters as given.
- `--runs N`: runs per check and side in the candidate plan, 3 by default.
- `--write FILE`: writes the candidate plan, which `verify` reads as it is. An existing file is replaced only with `--force`. With nothing to plan, nothing is written.
- `--json`: the full report.

The exit code is 0 when every changed file has a planned check and nothing needs input, and 2 when something needs review; 3 means a wrong reference, registry or option. Planning reads Git, the registry, the check files it names and the changed sources. It starts no app, runs no check, injects no fault, changes no project file and contacts no service.

## The workflow

1. **Inspect the change or the task**: what it is for and which screens it touches.
2. **Plan**: `recovery-probe plan --changed-since main --write .recovery-probe/verify.json`, and review the plan.
3. **Resolve what it asks for**: answer questions, state missing expectations, register scenarios for uncovered files that need one, and fix invalid entries. Do not invent selectors, endpoints, expected text or product requirements to fill a gap; ask whoever owns them.
4. **Record the baseline against the app before the change**: start that version, then `recovery-probe verify --baseline`.
5. **Change the code**, and restart or reload the app.
6. **Rerun the same checks**: `recovery-probe verify`.
7. **Report** the verdict, the evidence (`summary.md`) and what the checks do not cover.

If the code has already changed, a baseline run in this working tree tests the changed code: it is not a before-change baseline, and the plan says so. Check out the base separately, build and start that version, record the baseline there, then verify here with the same plan and folder:

```bash
here="$PWD"
git worktree add --detach ../before main
# build and start the app from ../before, then:
(cd ../before && npx recovery-probe verify --baseline --plan "$here/.recovery-probe/verify.json" --out "$here/.recovery-probe/verify")
# stop it, build and start the app from this checkout, then:
npx recovery-probe verify
```

Recovery Probe does not switch checkouts or start apps for you. When a baseline exists, the plan says whether it covers the planned checks, and warns when a changed file is older than the baseline, because then the baseline may already include the change. It cannot tell which code a baseline ran against. Verify keeps its own safeguards: a check whose command changed since the baseline, a missing baseline, or an incomplete run is never VERIFIED.

## From an AI coding agent

The [MCP server](mcp.md) offers the planner as `plan_verification` (the same report as `plan --json`), next to `verify_change`. Its instructions tell the agent to plan before recording a baseline and to report gaps as they are. MCP instructions are guidance; they do not make a host agent call any tool. If you want an agent to follow the workflow, say so in the repository's instructions, for example in `AGENTS.md` or `CLAUDE.md`:

```markdown
## Verifying changes
- Before changing code, call plan_verification for the change. Resolve its needsInput items with
  me; never invent an expectation, selector or endpoint.
- Record the baseline with verify_change (baseline: true) against the app before the change. If the
  code is already changed, tell me: the baseline must come from a checkout of the base.
- Before saying a change is done, call verify_change and quote its verdict and reasons. "No
  matching check" is not "safe": list the uncovered files in your summary.
```

## Writing scenarios that can verify a fix

Verify calls a change VERIFIED only when each check improved or stayed clean, so a check must come out clean when the app is right. The evaluation below found two ways to write a scenario that never can:

- **An `observe` scenario that starts on content loaded before the capture** reports `CONTENT_BEFORE_READ` on every run, before and after a fix. Start each run on a screen without the content, let the steps open it, and end by leaving it, so every run starts the same way.
- **An `observe` scenario whose `endpoint` is not the read that produces the content marker** reports `CONTENT_BEFORE_READ` whenever a sample lands between the two reads, so it passes once and fails over three runs. Point `endpoint` at the read that draws the marker; use `expect` steps for what later reads should change.

## The evaluation

`npm run eval:planner` runs a small, deterministic evaluation of the planner and the verify workflow on synthetic apps with known defects (`test/fixtures/plan-evaluation`). Each case commits a base, applies a change, plans it, records the baseline from a checkout of the base, verifies the change, and scores the result against `expected.json`, which the planner never sees. Case names, variants and expected outcomes are not planning inputs: the planner sees only the repository.

| Case | Change | Expected |
| --- | --- | --- |
| A failed read clears loaded content | keep the items after a failed refresh | scenario selected, defect reproduced, VERIFIED |
| Repeated failed reads, no required retry | retry up to three times | scenario selected, defect reproduced, VERIFIED |
| A successful read leaves a row in an old state | take the state from the status read | scenario selected, defect reproduced, VERIFIED |
| A legitimate empty result | refactor the inbox | no defect on either side, VERIFIED |
| A change no scenario covers | theme colors | no plan, file uncovered |
| A change whose expected behavior is unknown | sync merging | no plan, the registry's question asked |
| A change that introduces a defect | stop retrying after two failures | NOT VERIFIED |
| A helper only an import ties to a scenario | job formatting | a suggestion to review, no plan |

`npm run eval:planner -- --runs 3` repeats every check three times per side, as verify does by default. The evaluation shows that the planner and verify behave as specified on these cases. It is not evidence that Recovery Probe improves how a live agent works.

## A future live-agent comparison

To measure whether Recovery Probe helps an agent, compare two arms on the same tasks:

1. Tasks: defects with a known before and after behavior, such as the evaluation cases, plus unrelated and unknown-requirement controls. Write each task as an issue a developer would get, without the expected verdict.
2. Same starting state for both arms: repository commit, app build, test accounts, registry.
3. Same model, model version, temperature, tool budget, time limit and number of attempts.
4. Arm A: the normal development tools (editor, shell, tests, type checking). Arm B: the same tools plus the Recovery Probe MCP server and repository instructions like the ones above.
5. Score each attempt blind to the arm: defect fixed (checked by an independent check, not the agent's claim), regressions introduced, false claims of "fixed" or "safe", questions asked where the requirement was unknown, and tokens and time spent.
6. Repeat each task enough times to see variance, and report every run.

No such comparison has been run yet.

## Limits

- A plan covers what the registry covers. Files nobody mapped stay uncovered, and an outdated registry plans outdated checks: the plan flags patterns that match no file, but not checks that no longer test what their description says.
- Check files are checked for existence, location and valid JSON, not run or fully validated; verify runs them.
- Suggestions come from relative imports one step away. Re-exports, aliases, dynamic paths and indirect effects are not followed.
- Passing the planned checks shows that those checks passed, not that the application is correct. Keep type checking, tests and review.
