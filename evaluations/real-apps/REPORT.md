# Real-app bug hunt: results

**In short:** Recovery Probe 1.2.0-preview.1 was run against two production applications under active development, with no bugs planted and none known in advance. It found 12 user-visible failure-handling defects, 8 of them in the web app, and each was confirmed by hand. The most serious ones show wrong information as fact rather than an error: after two failed reads, an admin page lists every user as an ordinary user, and another names every licence after its release channel. The tool's static scan found none of these. The run also showed six gaps in the tool, one of which produced false `RECOVERED` results until it was noticed.

This is an exploratory study, not a controlled comparison. It shows what the tool surfaced on real code; it does not measure whether an agent without it would have found the same defects. How it differs from the [live-agent pilot](https://github.com/BojanKovachki/recovery-probe/pull/111) is explained [below](#how-this-differs-from-the-live-agent-pilot).

## The applications

The application names, screens and data reads are described generically here: both are proprietary.

| | Launcher | Admin portal |
| --- | --- | --- |
| Kind | Electron 29 desktop app | React web app (Vite, React Query 5) |
| How data reaches the screen | The renderer calls the main process over IPC; generated API clients in the main process call the backend | `fetch` from the page |
| Retry policy seen | React Query, three retries | React Query, one retry |
| Backend | a shared staging environment | a shared development environment |
| How Recovery Probe attached | the development IPC hook in the main process, CDP to the renderer, the Node inspector to the hook | CDP to a managed Edge profile; the organisation's sign-in policy blocks Playwright's Chromium |
| Screens covered | Home, Catalog, Downloads, Contacts, Settings, a package page | Users, Groups, Catalog licences, Partner licences, Company overview, Insights |

**Safety.** All faults were injected at the app's own boundary. Failed reads were answered by the IPC hook or by the page's request interception, and the action check answers write requests itself, so no write reached a server. The person whose accounts were used signed in themselves; the tool never handled credentials.

## Method

1. **Map the reads.** For the launcher, a fault-free observation over every IPC channel recorded which reads each screen makes when it is opened and when it is reloaded. For the portal, `recovery-probe reads` listed each page's GET requests.
2. **Sweep with discovery.** `recovery-probe discover` on the main read behind each screen:
   - over IPC: one rejection, two rejections, one `null` result, and failed 2nd–4th calls where a screen reads more than once;
   - over HTTP: two HTTP 503 responses in a row, one more than the portal retries.
   - Each experiment ran twice, after three healthy calibration loads.
3. **Check one write action.** `recovery-probe action` on starting a package download, the launcher action with the most user-facing feedback.
4. **Follow up by hand.** For each suspected defect, look at the screenshots, read the code behind it, and, where discovery's fixed faults didn't reach far enough, arm the hook directly and take timed screenshots.
5. **Scan statically.** `recovery-probe suspects` over both codebases, before any runtime experiment.

## Every experiment

### Launcher, discovery over IPC

The first sweep ran on the wrong screen; see [gap 1](#gaps-in-recovery-probe). Its three completed results are void and are not listed; the table shows the rerun.

| Screen | Read | Calls per load | Experiments (2 runs each) | Recovery Probe | Verified |
| --- | --- | --- | --- | --- | --- |
| Contacts | contacts list | 2 | rejection ×1, ×2, `null`, 2nd call | all `RECOVERED` | recovers |
| Settings | current user | 1 | rejection ×1, ×2, `null` | `RECOVERED`; `null`: `ERROR_OR_RETRY_SHOWN` | `null` sends a signed-in user to the sign-in screen (L4) |
| Settings | user settings | 1 | rejection ×1, ×2, `null` | all `RECOVERED` | recovers |
| Catalog | user's companies | 1 | rejection ×1, ×2, `null` | `RECOVERED`; `null`: `CONTENT_LOSS` | partner section blank (L3) |
| Catalog | company details | 1 | rejection ×1, ×2, `null` | all `RECOVERED` | recovers |
| Catalog | content metadata | 1 | rejection ×1, ×2, `null` | `RECOVERED`; `null`: `UI_DIFFERENCE_AT_DEADLINE` | no visible defect in the screenshots |
| Home | recently used | 1 | rejection ×1, ×2, `null` | all `RECOVERED` | recovers |
| Home | installed content | 14 | rejection ×1, ×2, `null`, 2nd–4th call | all `RECOVERED` | recovers |
| Downloads | installed content | 14 | rejection ×1, ×2, `null`, 2nd–4th call | all `RECOVERED` | recovers |

### Launcher, action check and hook follow-ups

| Experiment | Recovery Probe | Verified |
| --- | --- | --- |
| `action`: start a package download, failure and double-click runs | `SILENT_FAILURE`; `SINGLE_SUBMIT` | fake download progress for 10 s, then a silent revert (L1) |
| Hook: one rejected download start, screenshots at 0.5, 3, 9, 11.5 and 20 s | (manual) | as L1; the hook confirmed the handler was never called |
| Hook: four rejections of the user's-companies read at reload, screenshots up to 25 s | (manual) | partner section blank until the screen is reopened (L2) |

### Admin portal, discovery over HTTP (two 503s, 2 runs each)

| Page | Read | Recovery Probe | Verified |
| --- | --- | --- | --- |
| Users | users list | `CONTENT_LOSS` | "No entries found" (P1) |
| Users | pending invitations | `UI_DIFFERENCE_AT_DEADLINE` | difference not located; the visible part of the page was unchanged |
| Users | users' roles | `UI_DIFFERENCE_AT_DEADLINE` | every user shown as an ordinary user (P3) |
| Groups | groups list | `ERROR_OR_RETRY_SHOWN` | shows an error: handled correctly |
| Groups | default groups | `UI_DIFFERENCE_AT_DEADLINE` | every group "Default: No" (P7) |
| Catalog licences | licences | `UI_DIFFERENCE_AT_DEADLINE` | partner companies' items vanish (P5) |
| Catalog licences | content metadata | `CONTENT_LOSS` | every item named after its release channel (P4) |
| Partner licences | licences | `CONTENT_LOSS` | "No entries found" beside an active Grant button (P6) |
| Company overview | company details | `UI_DIFFERENCE_AT_DEADLINE` | placeholder logo, key shown as "—" (P8) |
| Company overview | users list | `UI_DIFFERENCE_AT_DEADLINE` | user count 0 (P2) |
| Users | signed-in user's roles | `FAULT_NOT_TRIGGERED` | inconclusive: the read was not retried, so the second fault never fired |
| Insights | historical licences | `BASELINE_NOT_HEALTHY` | not tested: the page never settled |
| Insights | usage names | `BASELINE_NOT_HEALTHY` | not tested: the page never settled |

### Static scan

| Codebase | Files | Suspects | Confirmed at runtime |
| --- | --- | --- | --- |
| Launcher (UI and main process) | 998 | 13 | none of them; the ones read were deliberate (a failed refresh keeps the last good list) |
| Admin portal | 325 | 0 | – |

## Findings

Each finding was seen in both runs of its experiment, or in the follow-up screenshots. None is from code reading alone.

### Admin portal

| # | When this read fails twice | The admin sees | Why |
| --- | --- | --- | --- |
| P1 | users list | Users page: "No entries found" | the hook returns `data ?? []` and no error |
| P2 | users list | Company overview: user count 0, for a company with several hundred users | same hook |
| P3 | users' roles | every user listed as an ordinary user; administrators and managers lose their roles on screen | a user with no role data is shown with the default role |
| P4 | content metadata | every licence named after its release channel, company "—" | without metadata, rows are built from the licences alone, which carry only the channel's name |
| P5 | licences | items licensed from partner companies disappear; the list looks complete | partner rows come only from the licences read, and the page doesn't show its failure |
| P6 | licences | Partner licences: "No entries found", next to an active Grant button | `data ?? []` |
| P7 | default groups | every group "Default: No" | the hook returns its error; the page ignores it |
| P8 | company details | placeholder logo, key "—" with the copy button enabled | minor |

P1–P7 present wrong information as fact. P3 and P7 are the kind an admin would act on, for example by granting a role again. The groups list itself handles the same failure correctly and shows an error, so the pattern is not universal. It comes from list hooks that turn a failed query into an empty array, and from pages that combine two reads without checking either for failure.

### Launcher

| # | Finding | Trigger |
| --- | --- | --- |
| L1 | A failed download start shows "Downloading 0.0 / N GB" for 10 s, then silently returns to "Download". The removal path clears its optimistic state on failure; the download path doesn't, and neither shows an error. The download queue also ignores some requests without failing, which looks the same to the user. | a rejected or ignored download start |
| L2 | The catalog's partner section stays blank, with no error or Retry, until the screen is reopened. | the user's-companies read failing for longer than the three retries (about 7 s) at startup |
| L3 | The same blank section. The query's `select` calls `.filter` on `null`. | that read returning an empty body |
| L4 | A signed-in user is sent to the sign-in screen. | the current-user read returning an empty body |

Everything else in the launcher recovered from one or two failed reads at load, including failed later calls, which is the behaviour earlier fixes in that codebase aimed for.

## Gaps in Recovery Probe

1. **Discovery accepted the wrong screen.**
   - A helper passed `#/route` through Git Bash, which rewrote it into a Windows path, and the app showed "Page not found". Discovery calibrated on that page and reported `RECOVERED` for every fault.
   - The report doesn't record the route, and nothing checks that the faulted read affects the screen. It was caught when later runs on the same page failed calibration and a screenshot showed the error page.
   - Recovery Probe's docs warn about the rewrite, but the tool doesn't detect its effect.
2. **Two faults is the most discovery can inject.** The launcher retries three times, so a startup outage needed a hand-written script (L2).
3. **The action check compares only end states.** L1's 10 s of false progress before a silent revert was reported as `SILENT_FAILURE`, the same as a screen that never changed. A simulated success can't produce the app's later progress events either, so the success run ended the same way.
4. **There's no read map over IPC.** `reads` lists a page's HTTP requests, but nothing lists which IPC reads a screen makes. A small script built one from a fault-free observation over every channel; it was the most useful setup step.
5. **The suspect scanner misses query results.** Its empty-default rule covers `?? []` straight after an `await`, not `data ?? []` on a query result, which is the pattern behind P1, P2 and P6.
6. **`action` has no `--screenshots`.** `discover` has one; the action check rejects it, so L1's evidence came from a separate script.

## How this differs from the live-agent pilot

| | Live-agent pilot 1 | This hunt |
| --- | --- | --- |
| Question | Does an agent fix known bugs better with Recovery Probe than without? | Does Recovery Probe find unknown bugs in real apps? |
| Apps | two small apps written for the pilot, one planted defect per task | two production apps, defects unknown |
| Design | controlled: 6 tasks × 2 conditions × 3 attempts = 36 attempts, same model, prompt and limits | exploratory: one agent using the tool directly, 25 experiments |
| Ground truth | known in advance; sealed graders | none in advance; each finding checked by hand against screenshots and code |
| Unit of the results table | one agent attempt | one experiment: a read or action, a fault, two runs |

The pilot's result was a ceiling: the tasks were easy enough that agents fixed them without the tool. This hunt points the other way on harder ground: P3, P4, P5 and P7 appear only where a page combines two reads, so no single hook shows them, and the static scan didn't flag them. That is evidence for the tool, not a measurement. A controlled follow-up would reuse the pilot's design on these screens: agents with and without Recovery Probe, asked to find failure-handling defects, graded against the findings above.

## Limits

- **Two apps, one account each, two runs per experiment.** `repeatConfirmed` needs three agreeing runs, so no finding is marked repeat-confirmed by the tool. Each was seen twice and checked by hand.
- **Only boundary faults.** Faults were injected at the IPC hook or the page's requests. Native transport, token expiry and real network loss weren't tested.
- **Wording-based recognition.** Discovery recognises error and empty states from English and German wording. Both apps ran in English.
- **No proof of absence.** A `RECOVERED` result covers one read, one screen and the faults tried; screens and reads not listed above weren't tested.
- **Proprietary evidence.** Screenshots, endpoints and channel names stay with the application's owners. This report describes them generically.
