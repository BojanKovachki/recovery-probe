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
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:package
npx playwright install chromium
npm run test:browser
npm run test:repair     # safety, authenticated portal, before/after pipeline
# After installing the optional Electron test runtime:
npm run test:repair:electron
```

Repair integration tests use a **controlled mock model response** but real apps, fault injection, source changes and reruns. They validate orchestration, not live AI diagnosis quality.

Code and JSON are formatted with Prettier (`npm run format`) and linted with ESLint (`npm run lint`); CI fails on either. Functions passed to `page.evaluate` run in the browser: keep them self-contained, and list new in-page modules in `eslint.config.mjs` so they get browser globals. TypeScript checks the JavaScript in `src`, `bin` and `examples` (`npm run typecheck`, `checkJs` without emitting); add JSDoc types where inference is not enough. Strict mode is off for now and can be tightened file by file. Markdown, HTML fixtures, report templates and workflow files are left as written. Report markup lives in `src/report-templates`: `{{slot}}` takes text and escapes it, `{{{slot}}}` takes markup built with `escapeHtml`. `.gitattributes` keeps LF line endings on every platform so local checks match CI. The repository-wide reformat is listed in `.git-blame-ignore-revs`; run `git config blame.ignoreRevsFile .git-blame-ignore-revs` to skip it in local blame.

## Install an unpublished source preview

When the version shown in the README is not on npm yet, install from a local checkout:

```bash
git clone https://github.com/BojanKovachki/recovery-probe.git
cd recovery-probe
npm ci
node bin/recovery-probe.mjs --version
node bin/recovery-probe.mjs --help
```

Record `git rev-parse HEAD` with any report so the source is reproducible. Use `node bin/recovery-probe.mjs` in place of `npx recovery-probe` in the guides when running from this checkout. Installing from source does not imply that the version is published to npm.

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

## Publishing a release

Run the package, browser and supported Electron CI jobs against the exact proposed source, inspect the tarball, update the installation guides and changelog, and merge only after those checks pass. Publish from the verified merged commit so npm `gitHead` and the GitHub tag agree.

Stable versions publish to `latest`; prereleases must explicitly use `--tag next` and the GitHub prerelease label. Run `npm publish --dry-run` before publishing. After publication, verify registry version, integrity and tags, install into a clean consumer, and check the CLI and exports before publishing the corresponding GitHub release. Never replace an existing npm version or move a released tag.
