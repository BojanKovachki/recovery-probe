# Setup effort for condition B

The pilot measures Recovery Probe with **prepared** scenarios. This page records what preparing them cost, separately from the attempts. The scenarios were written by the evaluation's author, who also wrote the apps and knew where each defect was, so this is a lower bound for a team that does not.

## What was prepared

| App | Scenario | Command | Covers |
| --- | --- | --- | --- |
| dispatch | `orders-refresh-keeps-orders` | `observe` with steps | ORD-3 |
| dispatch | `orders-ship-updates-row` | `observe` with steps | ORD-4 |
| dispatch | `orders-filter-latest-wins` | `observe` with tracked rows | ORD-2 |
| status board | `health-recovers-by-itself` | `check` | HLT-2 |
| status board | `notifications-empty-state` | `check` | NTF-2 |

Also prepared:
- two registries mapping the source files to the scenarios;
- a 30-line helper, `checks/open-browser.mjs`. It opens Chromium with a debugging port on the running app, because `observe` attaches only to a page that is already open. It opens the page again when the app's files change, so that the page runs the current code.

In all: 12 files and about 200 lines of JSON and JavaScript. Sync has no scenario, because no requirement covers it.

## Effort

About two and a half hours of wall-clock time, most of it waiting for six validation rounds of 13 to 20 minutes each. A round runs `self-check --run` three times on every task's starting code and on the reference apps.

| Round | Problems found | Fix |
| --- | --- | --- |
| Static preflight | none | – |
| 1 | `check` needs a ready selector that matches exactly one element (`#services li` matched five) | `#services li:first-child` |
| 1 | Dispatch showed its orders as soon as the page opened, so every capture started after the content arrived. `CONTENT_BEFORE_READ` appeared on every run of the correct app, and such a scenario can never come out clean | **App change**: an Overview start page, with the orders under `#/orders`, so the steps open them during the capture |
| 1 | Rows from an earlier run stayed on screen when Orders was opened again. They counted as content before the read | Region `#orders-view:has(#status:empty)` counts content only once loading has finished. Waits look for loaded rows |
| 1 | The correct app kept the previous filter's rows on screen until the new list arrived. Strictly, that breaks ORD-2, and a tracked-rows scenario flags it | **App change**: the reference store clears the list when the filter changes (Refresh on the same filter keeps it) |
| 1 | The validator started before the helper's browser had the app open | The validator waits for the page |
| 2 | The filter scenario clicked Shipped before the Orders view was shown: the route change is asynchronous | A `waitFor` on the filter button |
| 3 | Each scenario came out `findings` on its own defect and `clean` elsewhere. Two runs failed because the validator's cleanup left the helper's Chromium holding port 9222: on Windows a browser outlives its killed Node process | The validator ends whole process trees (a fix to the validator, not the scenarios) |
| 4 | none: every scenario `findings` on exactly its own defect over three runs, `clean` on every other build | – |
| Smoke attempts | An agent in condition B restarted the helper to load its changed code. It found the helper by command line, which matched its own session, and stopped every `chrome*` process on the machine | The helper opens the page again when `public/` changes, so it never needs a restart. The prompt goes to the agent on stdin, and both conditions are told to stop only processes they started |
| 5 | The new helper crashed on start (`browser.process` does not exist) | Fixed |
| 6 | none: every scenario `findings` on exactly its own defect over three runs, `clean` on every other build. This is the validation the pilot froze | – |

## What it means for the pilot

- **Two app design choices were made for the scenarios.** The Overview start page, and clearing the list when the filter changes, are reasonable designs, but they were made so that the `observe` scenarios could be clean. An app that shows its data the moment it opens needs a similar change, or a way to start the capture before the page loads, before Recovery Probe can verify a fix on that screen.
- **Each `observe` scenario carries this knowledge:** the app's loading indicator, its routes, and that scenarios share one page across runs. The shipping scenario changes server data: it can run three times before the app has to restart.
- **The cost lands on whoever writes the scenarios**, not on the agent in condition B. The agent still has to start the app and the browser helper before running an `observe` scenario.
