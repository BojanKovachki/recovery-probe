# Releasing

This checklist is for maintainers.

1. Confirm that `package.json`, `package-lock.json`, the changelog and the exact version in installation guides match. Record `git rev-parse HEAD` and require a clean working tree.
2. Run `npm ci`, `npm run test:all`, `npm run demo` and `npm run demo:browser`. Require successful CI for the release commit, including Windows packaging and both Electron versions. Keep Electron test installs separate from the package/TypeScript checks, as in CI.
3. Inspect the publish set with `npm pack --dry-run`. Run `npm publish --dry-run --tag next --access public` for a preview to exercise the publishing lifecycle without uploading.
4. Check `npm view recovery-probe dist-tags --json`, confirm that the intended version does not already exist, and verify the account with `npm whoami`. If authentication is needed, use `npm login --auth-type=web`; do not put credentials in the repository.
5. Publish previews with `npm publish --tag next --access public`. This checkout also sets `publishConfig.tag` to `next` to avoid accidentally replacing the stable channel. For an explicitly approved stable release, first update the version and `publishConfig.tag` to `latest`, then use `npm publish --tag latest --access public`.
6. Query `npm view recovery-probe@<version> version dist.integrity gitHead --json` and `npm view recovery-probe dist-tags --json`. Confirm the published source commit and intended tag; a successful GitHub merge is not publication.
7. Install `recovery-probe@<version>` into a clean temporary project and verify the CLI version and a real HTTP-backed fetch fault/recovery check. Use the exact version, not a potentially stale dist-tag.
8. Tag the exact published commit as `v<version>`.
9. Create a GitHub release from the matching changelog entry. Mark preview releases as prereleases and distinguish newly published capabilities from earlier GitHub-only previews.

Never publish from a dirty working tree or move an existing release tag.

## MCP Registry

For stable releases, update `server.json`'s top-level and npm package versions alongside `package.json`. Preserve the package's `mcpName` ownership field and the `mcp` package argument. Run `npm run demo:mcp` after installing Chromium; CI runs the same stdio demonstration.

Publish and verify npm **before** creating the version tag. `.github/workflows/publish-mcp.yml` publishes the matching registry entry using GitHub OIDC. It skips preview tags, requires an exact stable version and checks that npm already exposes the expected ownership metadata. No registry secret is needed. If npm propagation delays the job, rerun the failed workflow after verifying npm; do not move the tag or publish a second npm version just to retry it.

After the workflow succeeds, verify the exact name and version in the [MCP Registry](https://registry.modelcontextprotocol.io/). Registry publication is separate from npm publication. A failed registry job does not undo the npm release.
