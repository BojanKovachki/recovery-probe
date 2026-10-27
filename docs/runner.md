# JSON-configured runner

The original CLI runner suits pages that automatically load GET data, expose a visible Retry button after failure, and show a ready element after recovery. For other screens, use [guided setup](start.md), [discovery](desktop.md) or `withFault` in your own test ([API](api.md)).

```json
{
  "name": "Profile recovery",
  "url": "http://127.0.0.1:3000/profile",
  "requestPattern": "**/api/profile",
  "readySelector": "[data-testid=profile-ready]",
  "retrySelector": "[data-testid=profile-retry]",
  "timeoutMs": 3000
}
```

```bash
npx recovery-probe check --config recovery-probe.json --out artifacts/profile-recovery
```

The runner first checks the normal baseline in a fresh browser context. If that baseline fails, fault comparisons are skipped and reported as inconclusive. Each fault then receives its own fresh context with service workers blocked so Playwright can intercept the request.

The runner requires explicit selectors and endpoint matching. It does not discover an application's recovery policy.

## Exit codes

- `0`: every configured check passed, or the controlled demo observed its expected broken-versus-fixed result.
- `1`: a recovery check failed, was inconclusive, or was skipped.
- `3`: invalid arguments or configuration.
- `4`: it couldn't run, for example because Chromium isn't installed.

`--out` is a new folder for `report.json`. The old `recovery-probe --config FILE --out report.json` spelling still writes one file and exits with 2 on errors, until 1.0.

## Result codes

| Code | Meaning |
| --- | --- |
| `OK` | The configured assertion completed and the expected fault count was observed. |
| `RECOVERY_ASSERTION_FAILED` | The fault occurred, but the recovery assertion did not pass. |
| `FAULT_NOT_TRIGGERED` | The requested fault count was not observed. Check the route, method, cache, and service worker. |
| `BASELINE_FAILED` | The ordinary flow failed, so the runner could not make a useful fault comparison. The normal connection row's `reason` has the browser's error, for example a timeout or a selector that matched more than one element. |
| `INJECTION_ERROR` | Playwright could not apply or clean up the route reliably. |

A passing result proves the configured recovery behavior for that test. It is not a certification of overall application resilience.
