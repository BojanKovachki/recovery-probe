# Live-agent evaluation (experimental)

Does adding Recovery Probe help a real coding agent fix behavioral bugs, avoid regressions, and claim completion accurately? This folder holds a small, reproducible pilot that measures it: the same agent, model and tasks, with and without Recovery Probe. It is an evaluation, not a product feature, and a pilot of this size cannot give conclusive statistical evidence.

Results and their limits are in [REPORT.md](REPORT.md).

## Design

### Tasks

Six tasks on two small, runnable apps written for this evaluation (not copied from the planner evaluation): a warehouse **dispatch** console and an operations **status board**. Each app has a requirements document that both conditions see; each task has a realistic issue (`tasks/<id>/ISSUE.md`) that cites the requirement where one is known.

| Task | App | Kind | Issue |
| --- | --- | --- | --- |
| `refresh-clears-orders` | dispatch | fix | Orders disappear when a refresh fails |
| `health-gives-up` | status board | fix | The health panel gives up during an incident instead of retrying |
| `shipped-row-stale` | dispatch | fix | A shipped order still says "Packed" until a reload |
| `filter-race` | dispatch | fix, timing-sensitive | Switching filters quickly sometimes shows the wrong orders |
| `empty-notifications` | status board | control | A user with no notifications thinks the panel is broken; it isn't |
| `partial-sync` | status board | ambiguous | A partly failed sync shows mixed states; no requirement says what it should do |

A task's starting code is the app with one defect (`tasks/<id>/start/` replaces the app's files); the control and the ambiguous task start from the app as it is. The agents never see the reference apps, the graders, or where a defect is.

### Conditions

- **A**: Claude Code with its normal tools: editor, shell, the app's tests, and Playwright with Chromium in the project.
- **B**: the same, plus Recovery Probe (its MCP server and its command) and prepared scenarios: `recovery-probe/<app>/` adds a registry and check configurations to the workspace.

Both conditions get the same model and CLI version, prompt (B adds one paragraph naming the tool), starting code, requirements, time and turn limits, and settings. Each attempt runs in a fresh session and a fresh workspace, and the attempts run one at a time in a shuffled order with a recorded seed.

The pilot uses **prepared** scenarios. Someone who knew the app wrote and validated them before the pilot; it measures Recovery Probe with working scenarios, not automatic onboarding. Their authoring cost is recorded separately in [setup-effort.md](setup-effort.md). The registry is the same for every task of an app, and its expectations only cite requirements both conditions can read. There is no scenario for the sync behavior, because no requirement covers it.

### Grading

Graders are behavior checks with Playwright, independent of Recovery Probe's verdicts and of the agents' own tests (`grading/checks/`). Each check starts the app fresh from the attempt's code and reads what a user sees. A task's required checks come from `grading/rules.json`; every other check of the app is a regression check. Before the pilot, `grading/validate.mjs` showed that on each task's starting code the required checks fail (pass, for the control and the ambiguous task) and every regression check passes, and that every check passes on the reference apps, over three rounds.

An attempt's outcome, from `harness/score.mjs`:

| Measure | Meaning |
| --- | --- |
| success | fix: required checks pass and no regression; control: no change to app source and its behavior holds; ambiguous: status `needs_clarification` and no regression |
| regressions | regression checks that fail |
| incorrect claim | status `fixed` unless a real defect was fixed without regressions; status `no_change_needed` for a defect or with regressions |
| unnecessary change | the control's app source (`public/`, `data/`, `docs/`, `server.mjs`, `package.json`) changed |
| clarification | the ambiguous task ended with `needs_clarification` |
| execution | completed, failed or timed out; failed and timed-out attempts are graded on the code they left |

The agent ends with a structured report (`--json-schema`): its status and a summary. Time, turns, tokens, the CLI's cost estimate and every tool call come from the transcript.

### Isolation

The pilot ran on the Windows host, by the maintainer's choice. There, an agent's shell can read any file the user can, so isolation is partly enforced and partly detected:

- Graders, reference apps and validation results are sealed (AES-256-GCM) while the pilot runs, and every finished attempt's artifacts are sealed at once. The key file lives outside the checkout; agents never get it.
- Each workspace is a fresh folder outside the checkout, removed after the attempt. It holds only the task's starting code, its issue and, for B, the scenarios.
- File tools are denied reads of the checkout, the key folder, the harness's private files and Claude's own files. Web tools are off for both conditions.
- No CLAUDE.md, auto memory, hooks, skills or user settings are loaded, and no API key: attempts use the subscription login.
- Every tool call that names one of those places is flagged in the results. An attempt's shell could still read them on purpose; the flags show whether one did.

On Linux or WSL2, Claude Code's sandbox can enforce the same boundary for shell commands too; the harness keeps its paths and settings in `harness/agent.mjs` and `harness/pilot.mjs` for that.

## Reproduce

Requirements: Windows, macOS or Linux with Node.js 22, Git, Chromium for Playwright 1.62.1 (`npx playwright install chromium`), Claude Code 2.1.322 signed in with a subscription (the VS Code extension's binary is found automatically; `CLAUDE_CODE_CLI` names another), and free ports 4173 and 9222. From the repository root:

```bash
npm ci
node evaluations/live-agent/grading/validate.mjs 3            # graders: about 10 minutes
node evaluations/live-agent/grading/validate-scenarios.mjs 3  # B's scenarios: about 20 minutes
node evaluations/live-agent/harness/pilot.mjs freeze --run my-pilot
node evaluations/live-agent/harness/pilot.mjs run --run my-pilot      # resumable; --limit N runs N attempts
node evaluations/live-agent/harness/pilot.mjs unseal --run my-pilot
node evaluations/live-agent/harness/pilot.mjs grade --run my-pilot
```

`freeze` seals `apps/` and `grading/`, removes their plain copies, and records the hash of everything that defines the pilot. `run` and `grade` refuse to continue if any of it changed. `run` installs each app's dependencies and Recovery Probe once, outside the workspaces. It runs every attempt that has no sealed result yet, so it can stop and resume. `grade` rebuilds each attempt from its start commit and diff, runs the graders, and writes `runs/<name>/results.json` and `summary.md`. Each attempt folder holds `attempt.json`, the transcript, the final diff and the grade.

`npm run test:unit` covers the harness's isolation, reset and scoring rules (`test/unit/live-agent-*.test.mjs`).

## Files

| Path | What it holds | Agents see it |
| --- | --- | --- |
| `pilot.json` | tasks, conditions, repetitions, seed, model, limits, versions | no |
| `tasks/<id>/` | issue, starting-code overlay, app | the issue and the overlaid code |
| `recovery-probe/<app>/` | condition B's registry and check configurations | in B |
| `apps/` | the reference apps | only as each task's starting code |
| `grading/` | behavior checks, rules, validation results | no |
| `harness/` | workspace builder, agent runner, sealing, scoring, report | no |
| `runs/<name>/` | frozen definition, schedule, every attempt and its grade, results | no |
