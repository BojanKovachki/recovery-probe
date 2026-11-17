# Check your scenarios

**Experimental.** `recovery-probe self-check` checks the scenarios of your [registry](plan.md#the-registry) before you rely on them to verify a change. A before/after comparison means something only when its scenario can run, finishes, behaves the same on every run, and can come out clean. The self-check looks for those problems first: statically, and, when you ask, on a running build you name. It never verifies a change, and a clean result never means the app is correct.

## How it fits

| Step | Question it answers |
| --- | --- |
| [`plan`](plan.md) | Which registered checks does this change need? |
| `self-check` | Can those checks run, and do they behave the same on every run of a build I name? |
| [`verify`](verify.md) | Did the change improve the checks, from a baseline recorded before it? |

The self-check complements before/after verification. It does not replace the baseline, the comparison or their safeguards.

## Static preflight

```bash
npx recovery-probe self-check                       # every registered check
npx recovery-probe self-check items-keep-content    # only the named scenarios
```

For each registered check it looks at:

- the command, as [verify](verify.md#the-plan) takes it: `check`, `discover`, `action`, `observe` or `refresh`, with `--config` and without `--out`;
- its command line, parsed the way the command itself parses it: an unknown option, a missing value or a stray argument fails here, as it would when the check runs;
- the files it names (`--config`, `--steps`, `--state`, `--files`): inside the project, no symbolic link leading out, readable, and valid JSON (a JSON object for the configuration);
- values left to fill in, such as `{{origin}}` or `${HOST}`;
- the configuration and steps, with the validators the command itself uses and the command-line flags it merges (`--cdp`, `--page`, `--inspector`, `--restore-window`, and `--network` and `--files` for steps);
- what must be running for the check: the page, a debugging port, the IPC hook or a network proxy.

It starts nothing, runs nothing, contacts nothing and writes nothing. `--registry FILE` reads another registry, and `--json` prints the full report.

Registry entries that cannot be checked are never left out. An entry that is not an object, or has a bad or repeated name, bad paths or a malformed `check`, is listed under `invalidEntries` with the reason. It counts against the result when it concerns the selection: always when no names are given, and when it carries one of the names given otherwise.

The report's `passed` is true, and the exit code 0, only when every selected scenario passed, every name was found, and no invalid entry concerns the selection. Otherwise the exit code is 2; 3 means a wrong option or registry.

## Run on a reference build

```bash
# start the build you want to check the scenarios on, then:
npx recovery-probe self-check items-keep-content --run --reference "main at 7c43460, dev server"
```

`--run` runs each scenario that passes the preflight against the application that is running now. `--reference` is required: it names the build you started. Recovery Probe keeps that label as you gave it. It cannot tell which code the running application contains, and it does not switch checkouts, start apps or change code.

- Each run injects the faults and performs the actions its configuration names. Use development or test apps and accounts. The command says so on stderr before the first run.
- Each scenario runs `--runs N` times, one run after another (3 by default, up to 10). The runs use verify's safeguards: the same validated command, and a separate report folder for each run.
- The report goes to `.recovery-probe/self-check/report.json` and `report.md`. Each run's report is under `runs/NAME/run-N/`, and its output is in `run-N.log`. A new run replaces the earlier runs. `--out FOLDER` writes elsewhere: a relative path inside the project. Neither the folder nor the report files in it may be symbolic links; if one is, nothing runs.
- `passed` is true, and the exit code 0, only when every selected scenario is clean and the rest holds as above.

## Outcomes

Each scenario gets the first outcome that applies:

| Outcome | Means | Next |
| --- | --- | --- |
| `configuration-error` | The preflight found a problem. The scenario was not run. | Fix what it lists. |
| `preflight-passed` | Static only: the preflight found nothing. Nothing was run. | Run it on a build you name to learn more. |
| `execution-failed` | A run could not do its work: it wrote no report, or its report records an error, such as nothing answering on the debugging port. | Start what is missing or correct the address. The report lists what the check needs. |
| `incomplete` | A run did not complete: a coverage gap such as `CONTENT_MARKER_NOT_OBSERVED`, `OPERATOR_STEPS_INCOMPLETE` or `FAULT_NOT_TRIGGERED`. | An incomplete run is not evidence. The guidance names the usual causes of each gap. |
| `inconsistent` | The runs disagree: a problem appears in some runs and not in others. | Such a scenario cannot show what a change did. Look at waits and readiness in the steps, sampling against fast changes, and nondeterminism in the app or its data. |
| `findings` | The same problems on every run of the reference build. | If that build is meant to be correct, check the scenario's expectation and design. If it really has the defect, the scenario shows it there. |
| `clean` | Complete and consistent on every run, with no findings. | The scenario can come out clean on this build. Nothing more. |

A clean result does not show that the app is correct, that the scenario detects the defect it is meant for, or that any change is verified. To see whether a scenario detects its defect, self-check it on a build that has the defect: the scenario should come out `findings` there.

Guidance names possible causes, never a diagnosis. For example, `CONTENT_BEFORE_READ` with the basis `NO_READ_OBSERVED_IN_INTERVAL` means that the content was on screen while the configured read never happened. The capture may have begun after the content loaded, or the `endpoint` may not be the read that draws the content marker. The finding is a reason to look at both; it does not show which applies.

## The report

`report.md` from the [evaluation](#the-evaluation)'s late-capture case, where the app opens the list before the capture starts:

```markdown
## Recovery Probe scenario self-check (runtime)

Reference build, as declared by you: **synthetic app: capture-too-late** (3 run(s) per scenario).

### items-keep-content: findings on the reference build, the same on every run

- check: `observe --config checks/items.json --steps checks/items-steps.json`
- needs at runtime:
  - an app or browser with a debugging port at http://127.0.0.1:49681
- runs:
  - run 1: complete; CONTENT_BEFORE_READ (lead); .recovery-probe/self-check/runs/items-keep-content/run-1/report.json
  - run 2: complete; CONTENT_BEFORE_READ (lead); .recovery-probe/self-check/runs/items-keep-content/run-2/report.json
  - run 3: complete; CONTENT_BEFORE_READ (lead); .recovery-probe/self-check/runs/items-keep-content/run-3/report.json
- guidance:
  - CONTENT_BEFORE_READ, a lead, on every run of the reference build. Verify counts a problem left on both sides against VERIFIED, so if the build is correct this scenario cannot verify a fix until the lead goes away.
  - CONTENT_BEFORE_READ: content was on screen while the configured read never happened in that interval. This can mean the capture begins after the content loaded, or that the configured endpoint or channel is not the read that draws the content marker. Investigate both; the finding does not show which applies.

#### What this does not show

- The reference build is the one you declared. Recovery Probe did not verify which code the running application contains.
- A clean self-check never means the application is correct, the scenario is effective, or a change is VERIFIED. It complements before/after verification and does not replace it.
- Running a scenario injects the faults and performs the actions its configuration names.
- Suggested causes are possibilities to investigate, not diagnoses.
```

`report.json` holds the same, with each run's problems, gaps, and how each `CONTENT_BEFORE_READ` came about. It also records the files each check reads, with their hashes.

## With the planner

- `plan` checks every registered check with the same static preflight. A check that fails it is an invalid entry: it is listed under `needsInput` and not planned.
- When `.recovery-probe/self-check/report.json` holds a self-check that ran, each planned scenario shows its result under `selfCheck`: the outcome, when it ran, the reference you declared, and `inputsChanged`. A scenario whose self-check was not clean, or whose command or files changed since, adds a `self-check` item to `needsInput`. The check stays planned either way.
- `inputsChanged` compares the command and the hashes of the files it reads. Matching hashes show that those files are unchanged. They cannot show that the running app, its data or its environment are the same, so a saved self-check never stands in for a new one.
- The planner reads only the default folder. A self-check written elsewhere with `--out` is not shown.

## From an AI coding agent

The [MCP server](mcp.md) offers the self-check as `self_check_scenarios`, with the same report as `self-check --json`. Without `run` it only runs the static preflight. `run: true` needs `reference`, and the server's instructions tell the agent to run scenarios only when the user asks and names the running build. The tool is marked as one that can change state, because a run injects faults.

## The evaluation

`npm run eval:self-check` self-checks scenarios of the [planner evaluation](plan.md#the-evaluation)'s synthetic app (`test/fixtures/self-check-evaluation`). Each case serves that app with the case's own files on top, runs `self-check --run` three times per scenario through the CLI, and scores the result against `expected.json`, which the self-check never sees.

| Case | Scenario and build | Expected |
| --- | --- | --- |
| A correct scenario on a clean reference | items scenario, app that keeps its items | `clean` |
| The capture starts too late | the app opens the list before the capture | `findings`: `CONTENT_BEFORE_READ`, no read observed |
| An endpoint that is not the content's read | jobs scenario pointed at the status read | `findings`: `CONTENT_BEFORE_READ`, no read observed |
| Nothing running | nothing answers on the debugging port | `execution-failed` |
| Incomplete evidence | a content selector that matches nothing | `incomplete`: `CONTENT_MARKER_NOT_OBSERVED` |
| Repeated runs disagree | the status read answers Done and Running in turn | `inconsistent`: `EXPECTATION_NOT_MET` in run 2 only |
| A legitimate empty result | inbox with no messages | `clean` |
| A defect the corrected scenario still detects | items scenario, app that clears its items on a failed refresh | `findings`: `EXPECTATION_NOT_MET` on every run |

Each case also checks the exit code, that the reference is reported as declared by you, that a clean result says what it does not show, and that a `CONTENT_BEFORE_READ` cause stays a possibility. `npm run eval:self-check -- --runs 5` runs each scenario five times. The evaluation shows that the self-check behaves as specified on these cases. It does not show that it finds every weak scenario.

## Limits

- The reference build is what you declare. Recovery Probe does not check which code, data or environment the app runs with.
- A bounded number of runs can miss a rarer inconsistency: agreement over three runs is not proof of determinism.
- The static preflight does not open the app. It cannot tell whether a selector matches, an endpoint exists, or a page is open.
- A gap or a failed run in any run makes the scenario incomplete or failed, whatever the other runs found. Only problems decide between inconsistent and findings.
- Suggested causes are possibilities to investigate, not diagnoses.
