# A repeatable recovery check in CI

This synthetic example shows how to turn a specified recovery expectation into a CI result. It is not automatic discovery or a conversion of an arbitrary happy-path suite. Run it from a Recovery Probe source checkout with Node 22+:

```bash
npm ci
npx playwright install --with-deps chromium
npm run test:ci-example
```

The verifier runs the same saved `examples/ci/scenario.json` against broken and fixed versions of the bundled app. Both must pass the healthy baseline. It injects exactly one HTTP 503, clicks the explicit Retry button, then requires visible profile content with the exact expected text. The broken app leaves its loading guard set and cannot retry; the fixed app resets the guard and recovers.

The verifier only passes when the broken command exits 1 with `RECOVERY_ASSERTION_FAILED`, exactly one applied fault and verified cleanup, and the fixed command exits 0 with the same verified injection. A browser startup error, missed route or failed baseline does not count as detecting the defect. Each child has a 45-second timeout. Individual navigation and selector waits are bounded to 3 seconds. There are no test-runner retries that could hide the broken result.

To run a single variant as a normal gate:

```bash
node examples/ci/run.mjs fixed artifacts/my-recovery-run
```

Use a new output directory each time. Replace `fixed` with `broken` to observe exit 1. Exit 2 means an inconclusive/setup/cleanup failure. This command only starts the bundled synthetic application; adapting it to a real application requires explicit setup, actions and assertions.

Each variant saves `scenario.json`, `report.json`, `summary.md`, and baseline/fault Playwright trace ZIPs when tracing starts successfully. Open a trace locally:

```bash
npx playwright show-trace artifacts/my-recovery-run/fault-trace.zip
```

The scenario's selectors and expected text are synthetic. Traces record DOM snapshots, screenshots and sources; real-app traces may contain private data. Select artifact access and retention accordingly.

## GitHub Actions

The repository's Browser integration job runs the verifier and uploads artifacts even if a step fails. This standalone example assumes a checkout of this repository:

```yaml
name: Recovery example
on: [push, pull_request]
permissions:
  contents: read
jobs:
  recovery:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:ci-example
      - uses: actions/upload-artifact@v6
        if: always()
        with:
          name: recovery-example
          path: artifacts/ci-example-*/
          retention-days: 7
```

## Adapt it to an application

Install `recovery-probe@0.3.0` and your compatible Playwright runtime. Copy the example's orchestration pattern into your test suite, replace the synthetic server startup with your authorized test application, choose one read-only request and specify the expected recovery action and result. Keep the healthy control, bounded fault count, cleanup, inconclusive outcomes and process exit checks. Run the normal gate against the current app; the deliberately broken variant belongs only in a synthetic verification fixture.

This example provides local/CI execution and artifacts. It does not post PR comments, upload to a hosted Recovery Probe service or infer what your product ought to display.
