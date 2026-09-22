# Releasing

This checklist is for maintainers.

1. Confirm that the changelog and package version match.
2. Run `npm ci`, `npm run test:all`, and `npm run demo:browser`.
3. Inspect the publish set with `npm pack --dry-run`.
4. Confirm the package name and account with `npm view recovery-probe` and `npm whoami`.
5. Publish with `npm publish --access public`.
6. Install `recovery-probe@<version>` into a clean temporary project and rerun the package smoke test.
7. Tag the exact published commit as `v<version>`.
8. Create a GitHub release from the matching changelog entry.

Never publish from a dirty working tree or move an existing release tag.
