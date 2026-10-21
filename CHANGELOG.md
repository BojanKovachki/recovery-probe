# Changelog

All notable changes to Recovery Probe are documented here. The project follows [Semantic Versioning](https://semver.org/).

Version 0.2.0 is the first npm release. Earlier 0.1.x revisions were repository-only prototypes.

## 0.5.0 (2026-10-21)

Promotes previews 1–22 to the stable npm `latest` channel. The preview entries below retain the detailed history.

- Synchronize the brief-content observation fixture with completed samples so a slow sampler cannot race its restoration timer. Keep coverage of transitions entirely between samples.
- Complete the TypeScript migration of the library and CLI. Published JavaScript and declarations are built into `dist/`; public package imports and the `recovery-probe` command remain available.
- Add IPC action checks for simulated success, failure and double-clicks, delayed injected results, and scripted fill/press steps.
- Add a host-level HTTPS fault proxy and network steps during observation, plus evidence of local files removed by the app.
- Add MCP tools for coding agents, experimental source scanning with `suspects`, before/after report comparison, and `watch` to rerun checks after saves.
- Add experimental Android WebView attachment and Meta Quest keep-awake support, with diagnostics for visible pages that are not rendering.

Upgrading from 0.4.0: keep using the public package exports and CLI. If `RECOVERY_PROBE_IPC_MODULE` stores the old `src/ipc-probe.cjs` path, resolve it again with `node -p "require.resolve('recovery-probe/ipc')"`; it now points into `dist/`. Restart the development app after upgrading so its loaded IPC hook matches the CLI. The optional TypeScript peer dependency is needed only for source scanning. Experimental workflows remain experimental in this stable package.

## 0.5.0-preview.22 (2026-10-21)

- The command line is written in TypeScript under `src/cli` and compiled to `dist/cli`. `bin/recovery-probe.mjs` is now a launcher for it; the `recovery-probe` command, its options and its output are unchanged.
- `npm run demo` runs `dist/cli/core-demo.mjs`.

## 0.5.0-preview.21 (2026-10-21)

- The opt-in repair workflow (`recovery-probe repair`) is written in TypeScript. Its files, prompts and checks are unchanged.
- All of the library source is now TypeScript, and every published declaration is generated from it.

## 0.5.0-preview.20 (2026-10-21)

- HTTP discovery (`web --attach --discover`), the guided setup (`recovery-probe start`) and its content picker are written in TypeScript. Their reports and prompts are unchanged.

## 0.5.0-preview.19 (2026-10-21)

- The package root (`withFault`, `probeRecovery`), `recovery-probe/desktop` and `recovery-probe/web` are written in TypeScript. Their reports are unchanged.
- Their declarations are generated from the source instead of written by hand. They accept everything the old ones did and add `ValidDesktopConfig`, `DesktopDiscovery`, a typed `ProbeError` constructor, and the `baselineTimeoutMs`, `recoveryTimeoutMs` and `times` fields that `DesktopReport` already carried.
- The root declarations moved from `dist/index.d.ts` to `dist/index.d.mts`. The `types` fields point to the new file.

## 0.5.0-preview.18 (2026-10-21)

- Refresh experiments (`recovery-probe refresh`) are written in TypeScript. Their reports are unchanged.

## 0.5.0-preview.17 (2026-10-21)

- **`recovery-probe android --keep-awake`** keeps a Meta Quest's display awake and pauses the Guardian boundary until the forward stops, then restores both. Checks can then run on a headset that nobody wears.
- `android` warns when the display is asleep or the Guardian dialog has focus. The page then draws no frames, and clicks time out.
- Checks that record the window state now tell a visible page apart from one that only reports itself visible: `visible-not-rendering` (no frames) or `visible-without-viewport` (no size). They also say so on the terminal.
- Checked on a Quest 2: discovery and a recovery check on a production app's WebView, and clicks with `--keep-awake`. See docs/android.md.

## 0.5.0-preview.16 (2026-10-20)

- **`recovery-probe watch [PATH...] [-- CHECK]`** watches source files while you work. After each save it scans the changed files for suspects and reruns the check against the running development app. It compares the run with the first one and the one before, by the rules of `compare`.
- The check runs once at the start for the starting point. `--settle` waits for the dev server to reload, and each run gets its own folder and log.
- `summary.json` and `summary.md` (the pull request block for the first run against the latest) are rewritten after every run.
- Without a check, the watch only scans for suspects. See docs/watch.md.

## 0.5.0-preview.15 (2026-10-20)

- **`recovery-probe compare`** compares reports of the same check from before and after a change and says what happened to each problem: gone, new, still there, or not checked to the end. A problem counts as gone only when a complete run after the change checked it, so a run that stopped early never reads as a fix.
- Each side takes one or more reports, report folders or folders of runs, so repeated runs can be compared.
- It returns a verdict: `IMPROVED`, `PARTLY_IMPROVED`, `REGRESSED`, `MIXED`, `UNCHANGED`, `INCONCLUSIVE` or `NOT_COMPARABLE`. It exits 1 only for a new suspected defect.
- `--markdown` prints a block for the pull request. See docs/compare.md.
- The MCP server adds `compare_reports`, and tells agents to compare reports before they say a change fixed something.

## 0.5.0-preview.14 (2026-10-20)

- **`recovery-probe suspects`** (experimental) reads JavaScript and TypeScript sources for error handling that loses data:
  - `UNKNOWN_AS_EMPTY`: a failed or unexpected read becomes an empty collection;
  - `FAILURE_ONLY_LOGGED`: a read stores its data when it succeeds, but its failure is only logged.
- Each suspect names the read to fail and the check that proves or dismisses it. `--changed-since main` scans only what a branch changed, and `// recovery-probe-ignore` marks a reviewed line. It exits 2 when there are suspects to review. See docs/suspects.md.
- The MCP server adds `find_suspects`.
- TypeScript is a new optional peer dependency, needed only by the scanner.

## 0.5.0-preview.13 (2026-10-20)

- **`recovery-probe android`** (experimental) makes an Android app's WebView, or Chrome, inspectable like a desktop debugging endpoint. It finds the DevTools socket over adb, forwards a local port, checks that DevTools answers and removes the forward on exit. The printed URL works with `desktop --cdp` and as `cdp` in configs. It is served through a small bridge that hides blank WebViews, which Android pauses and which never answer, so a client does not wait on them. Checked on a Quest 2. See docs/android.md.

## 0.5.0-preview.12 (2026-10-20)

- **`recovery-probe mcp`** serves Recovery Probe to AI coding agents as MCP tools over stdio:
  - `find_page_reads` and `check_read_recovery` for a page's reads;
  - four tools that run the network fault proxy;
  - `run_recovery_probe` for observe, ipc, refresh, desktop and web.
- When an agent connects, the server tells it how to report results: a pass covers only what was checked, and inconclusive codes are not passes.
- A caught fault returns the report folder with `fix-brief.md` and `reproduce.mjs`.
- No new dependencies. See docs/mcp.md.
- The package description now says the checks can run from an AI coding agent.

## 0.5.0-preview.11 (2026-10-20)

- **`observe --files DIR`** compares the files under a directory at each interval and reports `LOCAL_FILES_REMOVED` when an interval lost files, with counts and bytes in the report and the paths in a private `files.json`. It catches a failed read that made the app delete installed content, which the screen alone does not show. See docs/observe.md.

## 0.5.0-preview.10 (2026-10-20)

- **Network steps** for `observe --steps`: with `--network URL`, a step can take hosts away from the app's own HTTPS connections through a running `recovery-probe net`, and `"restore"` brings them back. The capture always removes the faults at the end. The report records what each step faulted, adds `NETWORK_FAULT_NOT_TRIGGERED` or `NETWORK_FAULTS_NOT_RESTORED` coverage gaps, and labels the mode `observation with network faults`. See docs/observe.md.
- `recovery-probe net` runs without `--rules` and answers a loopback control; `recovery-probe/net` adds `connectNetworkFaults` and the `control` option.

## 0.5.0-preview.9 (2026-10-20)

- **`recovery-probe net`** fails an app's own HTTPS connections, for requests made outside the page by an SDK, a main process or a command-line tool. It runs a loopback proxy for the app's `HTTPS_PROXY` and refuses, resets, stalls or delays connections to the hosts you name, in time windows counted from the app's first connection. It can close open connections so clients have to reconnect. It sees only hosts and ports: HTTPS stays end to end. See docs/net.md.
- `recovery-probe/net` exports the same proxy as `startNetworkFaultProxy`.

## 0.5.0-preview.8 (2026-10-16)

- **`ipc --action`** checks what the user sees after an action that writes. It runs scripted setup steps, clicks the action while the hook answers its write channel, and compares a simulated success, a simulated failure and a double-click. It reports `SILENT_FAILURE`, `FALSE_SUCCESS`, `UNCLEAR_FEEDBACK`, `UNCAUGHT_ERROR` and `DUPLICATE_SUBMIT`. Nothing is written. See docs/ipc.md.
- Steps gain `fill` and `press`, also available to `observe --steps`. Typed values are never written to reports.
- The IPC hook can delay injected results with `delayMs` to simulate request time; `identify` reports this as `capabilities.faultDelay`.
- Discovery waits for the app's pending calls before each run, so its cleanup no longer fails when an app retry is still in flight.

## 0.5.0-preview.7 (2026-10-16)

- The IPC check and IPC discovery (`recovery-probe ipc` and `ipc --discover`) are written in TypeScript. Their reports are unchanged.

## 0.5.0-preview.6 (2026-10-16)

- The IPC development hook (`recovery-probe/ipc`) is written in TypeScript and still ships as the CommonJS file `dist/ipc-probe.cjs`. Its declarations are generated from the source and match the previous ones; `ProbeWebContents` gains the optional `getOwnerBrowserWindow` that the window controls use.

## 0.5.0-preview.5 (2026-10-16)

- The IPC control modules and `recovery-probe/ipc-inspector` are written in TypeScript. The inspector's declarations are now generated from its source and match the previous ones.

## 0.5.0-preview.4 (2026-10-16)

- `observe` is written in TypeScript, and the observation report has a complete schema type. Captures and reports are unchanged.

## 0.5.0-preview.3 (2026-10-16)

- The observation helpers are written in TypeScript: the in-page observation kit, scripted steps, the region reader and the HTTP observer. Their results are unchanged.

## 0.5.0-preview.2 (2026-10-16)

- The report modules are written in TypeScript: the HTML template renderer and the desktop, discovery and observation reports. The reports they write are byte-identical to before.

## 0.5.0-preview.1 (2026-10-16)

The first step of moving the package to TypeScript.

- The package is compiled into `dist/` and published from there. Package exports are unchanged, but `require.resolve('recovery-probe/ipc')` now returns a path ending in `dist/ipc-probe.cjs`. If you stored the old `src/ipc-probe.cjs` path in `RECOVERY_PROBE_IPC_MODULE`, run the command again after upgrading.
- `createFaultFetch` is written in TypeScript with strict checks, and its declarations are generated from the source. Its return type is exported as `FaultFetch`.
- TypeScript files are linted with typescript-eslint, so TypeScript is pinned to 6.0, the newest version typescript-eslint supports.
- A source checkout builds `dist/` during `npm ci`; test, demo and type-check scripts build first.

## 0.4.0 (2026-10-16)

The first stable release since 0.3.0. It contains 0.4.0-preview.1 to preview.5; their entries below have the details.

- **Observation:** record configured user actions and tracked row states. `DELAYED_UI_UPDATE` reports a row state that lags behind data the app already received. `observe --steps` runs explicit navigations, clicks and waits during a capture. The development IPC hook can count calls per method on shared channels and treat main-to-renderer pushes as data events.
- **Fixes:** `createFaultFetch` passes relative URLs through untouched. The IPC hook restores an app's own `webContents.send` wrapper after an observation. On Windows, repair proposals apply with Git's default line endings, and symlink sources are rejected.
- **Reports and checks:** HTML reports come from template files. CI checks formatting, lint and JavaScript types, and runs the repair pipeline on Windows.
- **Documentation:** a shorter README that leads with the demo, plus separate guides for the library API and the JSON-configured runner.

Upgrading from 0.3.0 needs no configuration or API changes. Restart a development app that loads the IPC hook, so the hook and the CLI come from the same version.

## 0.4.0-preview.5 (2026-10-16)

- Repair on Windows: the isolated checkout now holds the committed bytes instead of the CRLF line endings Git for Windows writes by default. A multi-line proposal with LF line breaks previously failed with "find text must match exactly once". `eol` rules in `.gitattributes` still apply.
- Repair on Windows: a committed symlink selected as a source is rejected again. Without symlink rights, Git for Windows checks it out as a plain file, which passed the old check; sources are now checked against the index.
- CI runs the repair pipeline on Windows.

## 0.4.0-preview.4 (2026-10-15)

- `createFaultFetch` passes relative URLs, such as `fetch('/api/x')`, to the supplied fetch untouched. Previously they threw `Invalid URL`.
- The HTML reports are built from template files in `src/report-templates`. Text slots are escaped, a missing slot throws, and the rendered text is unchanged.
- The README leads with one idea, whether apps show the right data, and with the demo. It drops from 2,380 to about 1,070 words. The fault kinds and library API move to `docs/api.md`, and the JSON-configured runner to `docs/runner.md`.

## 0.4.0-preview.3 (2026-10-15)

- Restore an existing instance-level `webContents.send` (for example an app's tracing wrapper) when an observation ends or the hook is disposed, instead of deleting it. Previously that wrapper was lost and later pushes bypassed it. A wrapper installed after the observation began is left in place.
- Broaden the project description: recovery after failed reads, cached content, and screens that lag behind their data. Observation and `DELAYED_UI_UPDATE` remain fault-free leads, not verdicts.

## 0.4.0-preview.2 (2026-10-15)

- Apply consistent Prettier formatting and add formatting, ESLint and JavaScript type checks to CI.
- Add JSDoc annotations for implementation type checking without a build step; strict mode remains off.
- Preserve original causes in two wrapped errors and make small lint-driven cleanups. No new observation or fault-injection features.
- Publish the maintenance changes from PRs #22–#24 on the opt-in `next` channel; stable `latest` remains 0.3.0.

## 0.4.0-preview.1 (2026-10-15)

- Record configured user actions during observation (name, time, real-input flag) and report the tracked rows that appeared or changed after each action.
- Track rows with hashed keys or configured aliases and allowlisted state labels. Add the `DELAYED_UI_UPDATE` observation: a row state that persisted across completed selected reads and then changed without a data event in the sampled window.
- Accept `{ css, role, name, text }` selectors for content, rows and actions.
- Let the development IPC hook count calls per method label on shared channels (`classify`) and observe main-to-renderer pushes as data events (`pushChannels`, `classifyPush`) without storing arguments or payloads. Select them with `methods` and `dataEvents`.
- Omit per-completion comparisons for busy targets with an explicit note, and print one comparison line per interval.
- Add opt-in `observe --steps` for explicit same-document navigation, clicks with real input events, waits and interval marks. Observation without steps still never acts.

## 0.3.0 (2026-10-14)

- Promote the validated 0.3.0 preview series to the stable npm `latest` channel: guided web/Electron setup, HTTP/IPC discovery and recovery checks, refresh experiments, fault-free observation, and a runnable CI example.
- Preserve initial content comparisons and add bounded follow-up evidence: first later baseline match, latest sampled comparison, sample bounds and unavailable-sample counts. Terminal, JSON and HTML distinguish a temporary difference from the last sampled state without claiming stability or ownership.
- Add controlled temporary-marker, later-divergence, interval-boundary and unavailable-evidence tests. Keep comparison tracking within the existing report cap.
- Align installation guides on 0.3.0, including the older repair guide. AI-assisted repair remains experimental and opt-in; explicit account-identity/ownership expectations remain outside this release.

### Upgrading from 0.2.0

The existing `withFault`, `createFaultFetch` and JSON-configured recovery CLI remain available. Use Node 22+ for the tester and Playwright 1.62.1 within the supported 1.x range for browser commands. The development IPC hook is tested in Electron 29.0.1 and 44.5.1; update its package and restart the development app when upgrading. New discovery workflows require explicit targets and calibrated healthy controls, and observation reports are not recovery or account-isolation verdicts. See the README workflow table for the new commands and their limits.

## 0.3.0-preview.14 (2026-10-14)

- Default fault-free observation to lightweight selected-content sampling; retain `detail: "region"` for full diagnostics. Explicit marker/text limits flag partial evidence; unrelated controls do not affect marker comparisons.
- Compare ordered visible marker text/count across observed read completions and operator intervals. Distinguish unchanged, changed and unavailable evidence, successful/failed settlements, and ambiguous completion during sampling. No freshness or ownership verdict is inferred.
- Measure renderer, protocol round-trip, summarization and counter-snapshot phases separately. Add a reproducible synthetic benchmark and controlled brief-transition coverage tests; no guaranteed temporal resolution is claimed.
- Persist separate cleanup readback evidence and label the observation snapshot as pre-cleanup. Extend browser and Electron checks; update the observation guide and CLI/HTML explanations.

## 0.3.0-preview.13 (2026-10-14)

- Add observation report provenance: package/CLI runtime, available browser version and allowlisted IPC hook version/runtime/capabilities. Older observation-capable hooks remain supported with unknown metadata.
- Measure completed-sample duration and actual start-to-start cadence independently of the configured post-sample delay, including unchanged samples. Report first-content sample bounds and explain no-read versus pending-read findings without changing their codes or verdict semantics.
- Add a runnable synthetic CI recovery example with a saved scenario, explicit content assertion, bounded 503 injection, nonzero failure exits, JSON/Markdown reports and Playwright traces. Verify broken and fixed controls in CI; setup failures cannot satisfy the expected broken result.

## 0.3.0-preview.12 (2026-10-14)

- Add `observe --config FILE` for fault-free HTTP/IPC read observation in an existing renderer without reloads, navigation, focus changes or UI cleanup resets. Operator interval markers preserve cumulative read history.
- Record read starts/completions and sampled content evidence, including `CONTENT_BEFORE_READ` observations. Pre-capture history remains unknown; no identity, ownership or security verdict is inferred.
- Add bounded, owned IPC observation leases, timestamped snapshots and the documented `recovery-probe/ipc-inspector` subpath. Old hooks fail capability checks before mutation.
- Validate cache reuse and stale content with synthetic browser/Electron fixtures, alongside a per-identity cache control. Document the session-isolation boundary of reload-based checks.

## 0.3.0-preview.11 (2026-10-14)

- Extend bounded end-state calibration to HTTP and IPC initial-load discovery: observe three full healthy windows and require matching stable end states before trusting a baseline or injecting faults.
- Accept genuinely empty selected regions after successful target/dependency reads. Retain calibration evidence and report `readiness.calibrationComplete`; failed calibration cannot claim verified final UI restoration.
- Use the configured `settleMs` consistently instead of deriving extra stability time from the duration of full calibration windows. Later controls and cleanup may finish early only after matching a trusted baseline.
- Add browser and real Electron regression cases for delayed image cards, empty regions and inconsistent end states.
- Align installation guides on the exact preview version, document an unpublished-source fallback, and default preview publishing to npm's `next` tag. This npm release also includes the previously unpublished preview.3–preview.10 changes below.

## 0.3.0-preview.10 (GitHub preview; npm publication separate)

- Calibrate HTTP/IPC refresh baselines using three full bounded windows and matching stable end states, rather than the first stable intermediate screen.
- Retain calibration evidence and trust a baseline only after all three reloads agree. Legitimate empty screens are not rejected based on item counts.
- Add delayed image-card and empty-content regression coverage.

## 0.3.0-preview.9 (GitHub preview; npm publication separate)

- Refresh the README, setup guides and package description around general web/Electron recovery testing; pin preview installation instructions.
- Add `refresh --config FILE [--json]` for explicit synthetic window-event experiments on populated screens, using HTTP or IPC fault adapters.
- Keep fault-free trigger controls, idle attribution checks, spontaneous observations, optional second-trigger recovery and final cleanup separate.
- Record content preservation independently from freshness, bounded no-subsequent-read observations, partial plans and repeat consistency without confirming inconclusive experiments.
- Add browser/Electron fixtures and documentation. No real network toggling, lifecycle emulation, token manipulation or generic global-function execution.

## 0.3.0-preview.8 (GitHub preview; npm publication separate)

- Subsequent healthy controls and final cleanup wait for the established baseline fingerprint within the existing baseline deadline. A stable intermediate screen no longer ends these phases early.
- Preserve completed runs as `INCOMPLETE_EXPERIMENT` findings when a later control stops an experiment. Show the observed interpretation and completed/planned counts without repeat confirmation.
- Add browser and Electron fixtures for delayed healthy content, plus bounded persistent mismatch and interrupted experiment checks. Initial baseline discovery still requires representative content and known relevant dependencies.

## 0.3.0-preview.7 (GitHub preview; npm publication separate)

- Compare rendered groups, image counts and hashed repeated-column distributions, separating observations from suspected interpretations.
- Retain failed controls and phase-stop evidence; compact reports and change-only bounded timelines.
- Add bounded repeated HTTP faults (`times`), structural HTTP discovery and `web --attach` with live session reuse.
- Separate baseline/recovery windows and measure sampled recovery/request completion timing.
- Add window-state diagnostics and explicit reversible un-minimizing, including a dev-only Electron fallback.
- Report repeated reads without claiming redundancy, and list observed non-GET/unselected request coverage gaps.
- Validate with synthetic grids, translated/icon-only states, virtualized DOM lists, explicit errors, empty results, delayed content and backoff; no claim of validation on an independent external app.

## 0.3.0-preview.6 (GitHub preview; npm publication separate)

- Add bounded `ipc --discover`: three healthy baselines, repeated controls, single/double rejection and null-result experiments, three repetitions by default.
- Report differential UI leads, repeat consistency, sampled recovery timing, bounded local timelines and coding-agent guidance. No readiness selector or retry-policy input required; the read channel and dev hook remain explicit.
- Preserve existing IPC verifier and public defaults; repeated hook faults are opt-in, atomically consumed and reset by run ID.
- English text heuristics and whole-region fingerprints can be inconclusive on changing/localized screens. No new web discovery or autonomous repair claims.


## [0.3.0-preview.5] - Unreleased

- Use synchronous Node inspector evaluation for synchronous IPC controls, avoiding implicit Promise collection failures in Electron's main process.
- Retain and explicitly await the asynchronous window-identification Promise, releasing its inspector object group afterward.
- Treat a lost begin reply as uncertain execution: attempt scoped reset and independently verify disarmed state even when begin/reset replies fail.
- Add protocol regression tests and real Electron lost-begin-reply fault-cleanup tests; fail closed when cleanup cannot be verified.

## [0.3.0-preview.4] - Unreleased

- Add an explicitly enabled main-process IPC registration adapter, scoped to allowed read channels and one window's main frame.
- Preserve normal call arguments, receiver and original return values; use no private Electron handler maps.
- Add one-shot rejection/null-result plans with IDs, TTL, reset, pending-call isolation and bounded per-channel counters.
- Add a noninteractive IPC checker over loopback Node inspector and renderer CDP, with measured baseline/deadline, dependency checks, fresh reloads and local reports.
- Treat extra traffic, missing dependencies and hidden/offline environments as inconclusive. Do not claim HTTP/Rust fault coverage.

## [0.3.0-preview.3] - Unreleased

- Attach to Electron without overriding download/focus/media defaults; fix older Electron rejecting Browser.setDownloadBehavior and test Electron 29.0.1 alongside 44.5.1.

- Add guided `start web` and `start desktop` commands with saved one-command reruns.
- Download missing Chromium automatically; combine manual login, request discovery, content picking, checks and local reports.
- Select a single Electron window automatically and show named choices for ambiguous windows/requests.
- Generate unique selectors from a user-selected content marker, and match Retry buttons by their visible label.
- Save private login state and configuration in an ignored local folder; no source access or AI upload in guided checks.
- Cover real browser setup/reruns, real Electron attachment and Windows publishing checks in CI.

## [0.3.0-preview.2] - 2026-10-05

- Add Chromium web discovery/checks and explicit private login-state saving.
- Add opt-in OpenAI source-edit proposals from selected source files and reproduced evidence.
- Reproduce and verify in a separate local clone; preserve the original repository and never push/deploy a candidate.
- Reject unsafe paths, ambiguous replacements, dirty baselines, preexisting target ports and setup/test mutations.
- Separate reviewed verification from explicit opt-in execution of unreviewed generated code.
- Add authenticated web and Electron before/after integration tests with controlled provider responses.
- Clarify release stages and source-upload/report privacy boundaries. Live model fix quality is not yet validated.

## [0.3.0-preview.1] - Unreleased

- Add Electron renderer discovery and targeted recovery checks through loopback CDP.
- Require a successful request after fault injection and a configured healthy UI marker.
- Add local HTML/JSON reports, executable reproductions, and coding-agent investigation briefs.
- Test real Electron attachment, preload preservation, recovery failures, automatic retry, stale UI markers, and disconnect behavior.
- Keep source-code fixes manual and reports local; native SDK/IPC traffic is outside this preview.

## [0.2.0] - 2026-09-22

### Added

- Deterministic HTTP error, connection failure, and invalid JSON injection.
- Playwright `withFault` helper with bounded counts and route cleanup.
- Browser-independent `createFaultFetch` adapter.
- JSON-configured CLI runner with human-readable and machine-readable output.
- Broken-versus-fixed browser demonstration.
- Core, real-browser, package-installation, and TypeScript integration tests.

[0.2.0]: https://github.com/BojanKovachki/recovery-probe/releases/tag/v0.2.0
