# Changelog

All notable changes to Recovery Probe are documented here. The project follows [Semantic Versioning](https://semver.org/).

Version 0.2.0 is the first npm release. Earlier 0.1.x revisions were repository-only prototypes.

## [0.3.0-preview.2] - Unreleased

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
