# Contributing

Thanks for helping make recovery checks easier to trust.

## Before opening a change

- Use Node.js 22 or newer.
- Keep changes focused on deterministic request-level recovery testing.
- Open an issue first for new fault models or public API changes.
- Do not include real credentials, production URLs, request bodies, or response bodies in fixtures or reports.

## Development setup

```bash
npm ci
npm test
npm run test:package
npx playwright install chromium
npm run test:browser
```

Run the controlled demonstrations when behavior or output changes:

```bash
npm run demo
npm run demo:browser
```

## Pull requests

A useful pull request:

- explains the recovery behavior it covers;
- includes a failing test for a bug fix;
- preserves the distinction between failed, inconclusive, and skipped results;
- keeps fault injection bounded and verifies that the fault occurred;
- updates the README and changelog when the public interface changes.

By submitting a contribution, you agree that it is licensed under the project's MIT license.
