# What the agents did: pilot-1

Descriptive, from the transcripts; not part of the frozen scoring. A shell command counts once for each purpose its text matches.

| Condition | Ran tests | Ran the app | Drove a browser | Used Recovery Probe |
| --- | --- | --- | --- | --- |
| A | 13/18 | 4/18 | 2/18 | 0/18 |
| B | 13/18 | 12/18 | 7/18 | 8/18 |

## Recovery Probe in condition B

| Attempt | MCP tools, in order | `recovery-probe` commands |
| --- | --- | --- |
| 01-filter-race-B2 | – | 0 |
| 02-partial-sync-B3 | – | 0 |
| 03-filter-race-B3 | – | 0 |
| 04-health-gives-up-B1 | plan_verification, run_recovery_probe check, run_recovery_probe check | 1 |
| 05-filter-race-B1 | run_recovery_probe observe, run_recovery_probe observe, compare_reports | 1 |
| 08-empty-notifications-B1 | – | 0 |
| 09-shipped-row-stale-B1 | plan_verification, run_recovery_probe observe, run_recovery_probe observe, compare_reports | 1 |
| 11-shipped-row-stale-B3 | – | 0 |
| 14-empty-notifications-B2 | – | 0 |
| 17-empty-notifications-B3 | – | 0 |
| 18-refresh-clears-orders-B3 | plan_verification, run_recovery_probe observe | 0 |
| 19-health-gives-up-B3 | – | 1 |
| 23-partial-sync-B2 | – | 0 |
| 26-health-gives-up-B2 | plan_verification, run_recovery_probe check, run_recovery_probe check | 0 |
| 27-shipped-row-stale-B2 | – | 0 |
| 31-refresh-clears-orders-B2 | run_recovery_probe observe | 1 |
| 34-partial-sync-B1 | – | 0 |
| 35-refresh-clears-orders-B1 | plan_verification, run_recovery_probe observe, run_recovery_probe observe, compare_reports | 0 |

