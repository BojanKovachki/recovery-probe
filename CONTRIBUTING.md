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
npm run api:check         # public API unchanged, or api/recovery-probe.api.md updated
npm test                  # unit tests, no browser
npm run test:package      # installs the packed package like a user would
npx playwright install chromium
npm run test:integration  # real Chromium
npm install --no-save --package-lock=false electron@44.5.1
npm run test:electron     # real Electron
```

Tests live in `test/unit`, `test/integration`, `test/electron` and `test/package`, and each script runs every `*.test.mjs` in its folder. Shared helpers are in `test/helpers` (free ports, launching an Electron fixture, the repair fixture) and fixture apps in `test/fixtures`. Electron tests start Electron through `test/helpers/electron.mjs`, which also clears `ELECTRON_RUN_AS_NODE` (some editors set it) and stops the whole process tree.

Tests are type-checked against the built declarations. Build a stand-in for a page, a browser or the IPC hook with `fake()` from `test/helpers/fake.mjs`: it takes only the members the test needs and is typed as the real thing, so a misspelled member fails the check. Mark input that is invalid on purpose with `// @ts-expect-error` and the reason.

`test/fixtures/report-shapes` lists, for each workflow, the report fields every run produces. Integration and Electron tests fail when a report lacks one, so a change cannot drop or rename a field unnoticed. Rerunning a suite with `UPDATE_REPORT_SHAPES=1` keeps only the fields that run produced too; delete a file first to record new fields, and run twice so fields that depend on timing drop out.

Repair integration tests use a **controlled mock model response** but real apps, fault injection, source changes and reruns. They validate orchestration, not live AI diagnosis quality.

Code and JSON are formatted with Prettier (`npm run format`) and linted with ESLint (`npm run lint`); CI fails on either. Functions passed to `page.evaluate` run in the browser: keep them self-contained, and list new in-page modules in `eslint.config.mjs` so they get browser globals. The package is written in TypeScript: modules are `.mts` (or `.cts` for CommonJS), and the command line lives in `src/cli`, with `bin/recovery-probe.mjs` only starting it. `npm run build` compiles them into `dist` with strict checks and generated declarations, and copies the report templates unchanged. `npm ci` builds once, and every script that runs code builds first, so tests never use a stale `dist`. `npm run typecheck` also checks the JavaScript in `bin`, `examples`, `scripts` and `test` (not the fixture apps) with strict mode off; add JSDoc types where inference is not enough. TypeScript is pinned to 6.0 because typescript-eslint, which lints the TypeScript files, does not support 7 yet. Markdown, HTML fixtures, report templates and workflow files are left as written. Report markup lives in `src/reports/templates`: `{{slot}}` takes text and escapes it, `{{{slot}}}` takes markup built with `escapeHtml`. `.gitattributes` keeps LF line endings on every platform so local checks match CI. The repository-wide reformat is listed in `.git-blame-ignore-revs`; run `git config blame.ignoreRevsFile .git-blame-ignore-revs` to skip it in local blame.

Code in `src` keeps functions to 50 lines and files to 300, not counting blank lines and comments, with a cyclomatic complexity of at most 12, at most 4 levels of nesting and at most 4 parameters. A function passed to `page.evaluate` may run longer, because Playwright sends only its source and its helpers must live inside it; mark it with an `eslint-disable` comment that says so, and keep each inner function within the other limits. Code older than these limits is listed in `eslint-suppressions.json`. `npm run lint` fails on a new violation, and on a listed one that no longer occurs: run `npx eslint . --prune-suppressions` after fixing one, so the list only shrinks.

`api/recovery-probe.api.md` lists the public API as the built type declarations describe it. `npm run api:check` fails when it is out of date; run `npm run api:report` after an intended change, so the change is visible in review.

## Layout

`src/` is split into layers, and each layer imports only itself and the layers below it:

| Folder | Holds |
| --- | --- |
| `hook` | The IPC hook, which runs inside the app's main process: CommonJS that imports nothing else from the package |
| `core` | Fault kinds, URL identity, reading and comparing the screen, package paths |
| `transports` | Failing reads: Playwright routes, the fetch wrapper, the HTTPS proxy, the IPC inspector and control |
| `targets` | Reaching the app: launching Chromium, attaching over CDP, window visibility, Android |
| `reports` | Report templates and the writers for check, discovery and action reports |
| `workflows` | The experiments: checks, discovery, refresh, observation, actions |
| `tools` | What's built on them: init, doctor, guided start, suspects, compare, watch, verify, MCP, repair |
| `cli` | Argument parsing and output |

The files directly in `src/` are the package's public entry points. They only re-export, so their import paths never change; `ipc-probe.cts`, which re-exports `hook`, is the file apps load by path. `test/unit/layers.test.mjs` fails when a module imports a layer above it at run time; type imports are free.

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
