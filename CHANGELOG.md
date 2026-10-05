# Changelog

All notable changes to Recovery Probe are documented here. The project follows [Semantic Versioning](https://semver.org/).

Version 0.2.0 is the first npm release. Earlier 0.1.x revisions were repository-only prototypes.

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
