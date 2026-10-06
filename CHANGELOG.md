# Changelog

All notable changes to Recovery Probe are documented here. The project follows [Semantic Versioning](https://semver.org/).

Version 0.2.0 is the first npm release. Earlier 0.1.x revisions were repository-only prototypes.

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
