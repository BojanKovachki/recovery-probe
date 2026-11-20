# Real-app study: does Recovery Probe help an agent find failure-handling bugs?

**In short:** 24 Claude Code sessions each tested one screen of one of two proprietary applications, a desktop launcher and an admin web portal, for what the user sees when a data read fails. Half had Recovery Probe and half didn't. Everything else was identical. The claims were graded blind, and every new claim was reproduced by hand.

- **Known defects.** With Recovery Probe, the agents found all 9 known defects at least once. Without it they found 7. The two they missed need an unusual trigger: a read returning `null`, and a read failing until the app's retries run out.
- **New defects.** 30 confirmed new defects were found, about equally by both conditions.
- **Precision.** The agents with Recovery Probe made no wrong claims; those without it made 3.
- **Cost.** Agents with Recovery Probe cost less by the CLI's estimate but took longer.
- **By app.** On the web app the two conditions were close. Most of the difference is on the desktop app.

With two attempts per task and condition, every difference is a count of one to three: descriptive, not statistical. The known defects mostly come from the tool's own [bug hunt](https://github.com/BojanKovachki/recovery-probe/pull/112) on these screens, which favours the tool. The held-out screens, below, are the fairer comparison, and there the result is mixed.

## Design

| | |
| --- | --- |
| Applications | The launcher and admin portal from the [bug hunt](https://github.com/BojanKovachki/recovery-probe/pull/112): an Electron 29 desktop app on a shared staging backend, and a React web app (Vite, React Query 5) on a shared development backend. |
| Tasks | Launcher: Catalog, Settings, Files (held out). Portal: Users, Catalog licences, User details (held out). Held-out screens weren't part of the hunt or the tool fixes that followed it. |
| Conditions | A: Playwright in the workspace. B: the same plus Recovery Probe 1.2.0-preview.1 (main 8757fa5) as an MCP server and a command, with no prepared scenarios. |
| Agent | Claude Code 2.1.327 in print mode, Claude Sonnet 5.5, effort high, 150 turns, 35 minutes. No CLAUDE.md, memory, hooks, skills or web tools. |
| Each attempt | A fresh workspace with the app's source at a fixed commit, the live app on its task's screen, and one prompt: find user-visible failure-handling defects on this screen and report each with its trigger and what the user sees. Reads outside the workspace denied. |
| Safety | Write guards in the launcher's main process and in the browser rejected every write request. The guards blocked nothing during the attempts. The app or browser was restarted before every attempt. |
| Order | 2 repetitions × 2 conditions × 6 tasks, in a seeded shuffle per app. The setup was frozen before each app's block; two harness fixes during the run were recorded as amendments, and no attempt was excluded. |

## Grading

The protocol was written before any attempt ran:

1. Every finding from every report is a claim. Words that reveal the condition were redacted, and the claims were shuffled.
2. A separate grader agent, seeing only the protocol, the known defects and the blinded claims, matched each claim to a known defect. A match needs the same read, the same kind of trigger and the same symptom. It grouped the remaining claims into unique claims.
3. Each unique claim was reproduced by hand on the live app with its own hand-written fault: a wrapped IPC handler for the launcher, a Playwright route for the portal. Each was graded `confirmed`, `not reproduced`, `not a defect` or `unclear`. Two judgement rules were written down before this step:
   - An empty result that looks exactly like a user who has nothing is not a defect.
   - Keeping the last good data after a failed refresh is fine.

Of 43 unique new claims, 30 were confirmed, 5 were not defects, 4 didn't reproduce, and 4 were unclear because their precondition couldn't be set up without writing data.

One verdict was corrected after the report was first published. A code review showed that one claimed "No entries found" was text hidden under a loading skeleton that never resolves, so that claim doesn't reproduce as described. Every other verdict judged from page text was then checked against its screenshot.

## Results

| | A: without | B: with Recovery Probe |
| --- | --- | --- |
| Claims | 60 | 47 |
| Known defects found, per attempt (of 18 chances) | 13 | 15 |
| Distinct known defects found (of 9) | 7 | 9 |
| Distinct confirmed new defects (of 30) | 28 | 25 |
| Wrong claims | 3 | 0 |
| Unclear claims | 4 | 1 |
| Timed out | 0 | 1 |
| Minutes, total (a timeout counts as 35) | 94 | 140 |
| CLI cost estimate | $7.04 | $4.63, plus one attempt with no estimate |
| Recovery Probe calls | – | 51 |

### Known defects, attempts that found each (of 2)

| Screen | Defect | A | B |
| --- | --- | --- | --- |
| Catalog | the user's companies fail until retries stop: the partner section is blank | 2 | 2 |
| Catalog | the user's companies read returns `null`: the same blank section | 0 | 1 |
| Settings | the current user is `null`: a signed-in user sees the sign-in screen | 1 | 1 |
| Settings | the current user fails until retries stop: the sign-in screen | 0 | 1 |
| Files | the files read fails twice: the "no files yet" empty state | 2 | 2 |
| Users | the users read fails twice: "No entries found" | 2 | 2 |
| Users | the users' roles fail twice: everyone shown as an ordinary user | 2 | 2 |
| Catalog licences | content metadata fails twice: every row named after its channel | 2 | 2 |
| Catalog licences | licences fail twice: licensed items silently missing | 2 | 2 |

The two defects only B found are the triggers Recovery Probe tries on its own: a `null` result, and failing every read, an experiment added after the hunt. A's launcher agents also injected faults, by replacing main-process IPC handlers, but no claim from condition A reported either defect.

### By task

| Task | Known found, A / B | Distinct new, A / B | Wrong, A / B | Minutes, A / B |
| --- | --- | --- | --- | --- |
| Launcher Catalog | 2 / 3 (of 4) | 2 / 2 | 1 / 0 | 17 / 21 |
| Launcher Settings | 1 / 2 (of 4) | 3 / 0 | 0 / 0 | 18 / 53 |
| Launcher Files (held out) | 2 / 2 (of 2) | 2 / 1 | 2 / 0 | 14 / 16 |
| Portal Users | 4 / 4 (of 4) | 4 / 3 | 0 / 0 | 12 / 11 |
| Portal Catalog licences | 4 / 4 (of 4) | 4 / 4 | 0 / 0 | 9 / 15 |
| Portal User details (held out) | – | 13 / 15 | 0 / 0 | 24 / 22 |

- **Launcher Settings:** one B attempt spent its time in a long discovery run and timed out without a report. The other found both known defects but no new ones, while A's two attempts found three new Settings defects between them.
- **Portal:** the two conditions were close. They found the same known defects, and their new-defect counts were within two of each other on every screen. HTTP faults are easy to inject with Playwright routes, and every condition-A attempt on the portal did so.

### What the new defects look like

In all 30, the screen states something untrue or drops data, with no error that names the failure and no way to retry. Examples:
- **Access denied for good.** One failed access check shows "Access denied" to a user who has access. The app never asks again.
- **A wrong "not found".** One failed read of a user shows "This user could not be found".
- **Raw ids.** A failed role catalogue shows each role as a raw id.
- **A setting shown wrong.** One failed settings read shows a switch as off for a user who has it on, and it stays off after the read recovers.
- **A healthy list shown as empty.** A local file-versions read that fails, or never answers, replaces a healthy file list with the empty state.

## Limitations

- **Very small sample.** Two attempts per cell. A different seed could change any per-task difference.
- **A ground truth that favours the tool.** 8 of the 9 known defects were found by Recovery Probe in the hunt, and the every-read experiment was added because of it. The held-out screens are less biased, and there the result is mixed:
  - B found more on User details (15 vs 13 distinct) and fewer on Files (1 vs 2);
  - A's two wrong claims are both on Files.
- **One verifier.** The verifier was blind to condition but not to claim text, and the judgement rules were fixed before verification.
- **Partial blinding.** A few claims describe how their fault was made, which hints at the condition.
- **One model and one prompt.** Another model or a prompt that names `null` results and exhausted retries might close the gap on known defects.

## Takeaways for the tool

- **What it adds.** On these apps, Recovery Probe's value was the triggers an agent doesn't think of, `null` results and exhausted retries, plus fewer false claims. It didn't add breadth: agents without it found as many new defects by injecting failures themselves.
- **Long runs.** A discovery run can take much of a 35-minute budget, and in one attempt it took all of it. A bounded run, or results streamed as each experiment finishes, would make it safer inside a time-boxed agent session.
