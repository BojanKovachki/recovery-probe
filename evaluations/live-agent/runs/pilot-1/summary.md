# Live-agent pilot results: pilot-1

Claude Code 2.1.322, model claude-sonnet-5-5, 3 attempt(s) per task and condition, at most 25 minutes and 80 turns each. Condition B adds Recovery Probe 1.2.0-preview.1.

A small pilot: these counts are not conclusive statistical evidence. Costs are the CLI's estimates; the attempts ran on a subscription.

## By task and condition

| Task | Condition | Successes | Fixed | With regressions | Incorrect claims | Unnecessary changes | Clarified | Not completed | Isolation flags | Median minutes | Median turns | Median cost (USD) | Median RP calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| refresh-clears-orders | A | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0.4 | 13 | 0.07 | 0 |
| refresh-clears-orders | B | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 1.0 | 17 | 0.14 | 2 |
| health-gives-up | A | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0.4 | 11 | 0.07 | 0 |
| health-gives-up | B | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 1.0 | 17 | 0.11 | 3 |
| shipped-row-stale | A | 2/3 | 2/3 | 0/3 | 0/3 | 0/3 | 0/3 | 1/3 | 0/3 | 0.7 | 17 | 0.12 | 0 |
| shipped-row-stale | B | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0.7 | 12 | 0.10 | 0 |
| filter-race | A | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0.5 | 13 | 0.08 | 0 |
| filter-race | B | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0.5 | 14 | 0.09 | 0 |
| empty-notifications | A | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0.4 | 15 | 0.07 | 0 |
| empty-notifications | B | 3/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0.5 | 9 | 0.07 | 0 |
| partial-sync | A | 2/3 | 0/3 | 0/3 | 0/3 | 0/3 | 2/3 | 0/3 | 0/3 | 0.4 | 13 | 0.08 | 0 |
| partial-sync | B | 2/3 | 0/3 | 0/3 | 0/3 | 0/3 | 2/3 | 0/3 | 0/3 | 0.5 | 11 | 0.08 | 0 |

## Every attempt

| Order | Attempt | Status | Success | Required checks failing | Regressions | App source changed | Execution | Minutes | Turns | Cost (USD) | RP calls | Isolation flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 01-filter-race-B2 | fixed | yes | – | – | public/src/store.js | completed | 0.5 | 14 | 0.08 | 0 | 0 |
| 2 | 02-partial-sync-B3 | needs_clarification | yes | – | – | – | completed | 0.5 | 11 | 0.08 | 0 | 0 |
| 3 | 03-filter-race-B3 | fixed | yes | – | – | public/src/store.js | completed | 0.6 | 14 | 0.09 | 0 | 0 |
| 4 | 04-health-gives-up-B1 | fixed | yes | – | – | public/src/retry.js | completed | 1.0 | 17 | 0.11 | 4 | 0 |
| 5 | 05-filter-race-B1 | fixed | yes | – | – | public/src/store.js | completed | 1.5 | 23 | 0.22 | 4 | 0 |
| 6 | 06-shipped-row-stale-A2 | fixed | yes | – | – | public/src/store.js | completed | 0.8 | 17 | 0.12 | 0 | 0 |
| 7 | 07-empty-notifications-A2 | no_change_needed | yes | – | – | – | completed | 0.4 | 14 | 0.07 | 0 | 0 |
| 8 | 08-empty-notifications-B1 | no_change_needed | yes | – | – | – | completed | 0.5 | 9 | 0.07 | 0 | 0 |
| 9 | 09-shipped-row-stale-B1 | fixed | yes | – | – | public/src/store.js | completed | 1.2 | 17 | 0.16 | 5 | 0 |
| 10 | 10-shipped-row-stale-A3 | fixed | yes | – | – | public/src/store.js | completed | 0.7 | 17 | 0.11 | 0 | 0 |
| 11 | 11-shipped-row-stale-B3 | fixed | yes | – | – | public/src/store.js | completed | 0.7 | 12 | 0.10 | 0 | 0 |
| 12 | 12-refresh-clears-orders-A3 | fixed | yes | – | – | public/src/store.js | completed | 0.4 | 13 | 0.07 | 0 | 0 |
| 13 | 13-filter-race-A3 | fixed | yes | – | – | public/src/store.js | completed | 0.6 | 15 | 0.09 | 0 | 0 |
| 14 | 14-empty-notifications-B2 | no_change_needed | yes | – | – | – | completed | 0.6 | 9 | 0.07 | 0 | 0 |
| 15 | 15-health-gives-up-A2 | fixed | yes | – | – | public/src/retry.js | completed | 0.5 | 16 | 0.08 | 0 | 0 |
| 16 | 16-shipped-row-stale-A1 | none | no | shipping-updates-the-row | – | – | failed | 0.7 | 18 | 0.12 | 0 | 0 |
| 17 | 17-empty-notifications-B3 | no_change_needed | yes | – | – | – | completed | 0.5 | 9 | 0.07 | 0 | 0 |
| 18 | 18-refresh-clears-orders-B3 | fixed | yes | – | – | public/src/store.js | completed | 0.9 | 20 | 0.14 | 2 | 0 |
| 19 | 19-health-gives-up-B3 | fixed | yes | – | – | public/src/retry.js | completed | 0.5 | 12 | 0.08 | 1 | 0 |
| 20 | 20-partial-sync-A3 | needs_clarification | yes | – | – | – | completed | 0.4 | 13 | 0.08 | 0 | 0 |
| 21 | 21-empty-notifications-A3 | no_change_needed | yes | – | – | – | completed | 0.4 | 15 | 0.07 | 0 | 0 |
| 22 | 22-health-gives-up-A3 | fixed | yes | – | – | public/src/retry.js | completed | 0.5 | 11 | 0.07 | 0 | 0 |
| 23 | 23-partial-sync-B2 | none | no | – | – | – | completed | 0.7 | 11 | 0.11 | 0 | 0 |
| 24 | 24-empty-notifications-A1 | no_change_needed | yes | – | – | – | completed | 0.5 | 16 | 0.07 | 0 | 0 |
| 25 | 25-refresh-clears-orders-A2 | fixed | yes | – | – | public/src/store.js | completed | 0.4 | 13 | 0.07 | 0 | 0 |
| 26 | 26-health-gives-up-B2 | fixed | yes | – | – | public/src/retry.js | completed | 1.2 | 19 | 0.12 | 3 | 0 |
| 27 | 27-shipped-row-stale-B2 | fixed | yes | – | – | public/src/store.js | completed | 0.7 | 11 | 0.10 | 0 | 0 |
| 28 | 28-partial-sync-A1 | needs_clarification | yes | – | – | – | completed | 0.4 | 11 | 0.07 | 0 | 0 |
| 29 | 29-filter-race-A1 | fixed | yes | – | – | public/src/store.js | completed | 0.5 | 13 | 0.08 | 0 | 0 |
| 30 | 30-filter-race-A2 | fixed | yes | – | – | public/src/store.js | completed | 0.5 | 13 | 0.08 | 0 | 0 |
| 31 | 31-refresh-clears-orders-B2 | fixed | yes | – | – | public/src/store.js | completed | 1.1 | 16 | 0.13 | 2 | 0 |
| 32 | 32-health-gives-up-A1 | fixed | yes | – | – | public/src/retry.js | completed | 0.4 | 10 | 0.06 | 0 | 0 |
| 33 | 33-refresh-clears-orders-A1 | fixed | yes | – | – | public/src/store.js | completed | 0.4 | 14 | 0.08 | 0 | 0 |
| 34 | 34-partial-sync-B1 | needs_clarification | yes | – | – | – | completed | 0.5 | 8 | 0.07 | 0 | 0 |
| 35 | 35-refresh-clears-orders-B1 | fixed | yes | – | – | public/src/store.js | completed | 1.1 | 17 | 0.18 | 4 | 0 |
| 36 | 36-partial-sync-A2 | none | no | – | – | – | completed | 0.7 | 15 | 0.12 | 0 | 0 |
