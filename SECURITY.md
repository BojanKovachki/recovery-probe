# Security

## Supported versions

Security fixes are applied to the latest published version of Recovery Probe.

## Preview repair trust boundary

Repair operates on a separate local clone, **not an OS/network security sandbox**. Launch scripts, setup/test commands and generated application code execute with your user's filesystem/network privileges. Use trusted configuration and a disposable development container or VM for unreviewed candidates. No production credentials or production mutation targets.

Source upload is opt-in and file-allowlisted, but secret detection is not comprehensive: review `repair-request.json` before generation. Provider keys are not passed to child commands; processes can still access credentials on disk outside a sandbox. There is no implicit upload, automatic merge or deployment.

Saved browser state, Electron test profiles, source bundles, expected text, command logs and screenshots can contain private data. Output permissions are restrictive on POSIX; verify ACLs yourself on Windows. Never commit these artifacts. Before using an employer's code or services, obtain the required authorization.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use [GitHub's private vulnerability reporting](https://github.com/BojanKovachki/recovery-probe/security/advisories/new) and include:

- the affected version;
- a minimal reproduction;
- the expected and observed behavior;
- any known impact.

Reports should not contain real credentials, production request data, or other sensitive application information. I aim to acknowledge reports within seven days.
