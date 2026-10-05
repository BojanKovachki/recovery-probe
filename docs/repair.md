# Web and Electron repair preview

This is `0.3.0-preview.2`, available from `feat/repair-workflow`, not npm `latest` (0.2.0).

## What it actually does

1. Run a normal-load baseline, then inject one failed GET request per configured fault.
2. Confirm the real fault occurred and observe whether a later successful request and the expected loaded content appear. Automatic recovery needs no Retry UI.
3. For a reproduced failure, read only the application source files you explicitly list.
4. With consent and your own API key, ask an OpenAI Responses model for a minimal edit proposal.
5. Apply a reviewed proposal **only to a separate checkout**. Relaunch that build, rerun the unchanged scenario and your supplied tests, and save `candidate.patch` plus before/after evidence.

The original repository is not edited. Nothing is committed, pushed, merged or deployed. There is no runtime agent installed into your production app. One proposal attempt is made; it may fail or decline to patch. The tests use a controlled mock provider, not a measured live-model success rate.

It currently targets request-failure recovery bugs, not arbitrary bugs. It cannot infer product requirements, fix inaccessible backend code, intercept Rust/native/IPC networking, or certify the whole application. Choose an expected outcome that genuinely demonstrates the selected endpoint's data loaded, not a static heading or spinner disappearing. HTTP success alone does not prove the response is semantically correct.

## Install in a separate tools folder

Node 22+, Git and Playwright Chromium are required. You do not have to modify your work app's dependencies to run the tool.

```bash
mkdir recovery-probe-tools
cd recovery-probe-tools
npm init -y
npm install --save-dev github:BojanKovachki/recovery-probe#feat/repair-workflow playwright
npx playwright install chromium
npx recovery-probe --version
```

Pin the branch's commit SHA instead of its name for a reproducible install. `npm install recovery-probe` still gives the older stable package.

## First test: user portal, without AI or source upload

Start your portal locally using its existing development command and a test account/backend. If login is required:

```bash
npx recovery-probe web --login --url http://127.0.0.1:3100 --state ./private-portal-state.json
```

Sign in yourself in the Chromium window, return to the app, then press Enter in the terminal. The command refuses to overwrite an existing state file. State includes cookies/local storage/IndexedDB, not session storage. Keep it private. Session-storage-only auth needs your existing Playwright login fixture with the `withFault` helper; this preview does not export that state. Use the same origin/port for subsequent checks.

```bash
npx recovery-probe web --discover --url http://127.0.0.1:3100/users --state ./private-portal-state.json --out ./portal-discovery
```

Fill the generated `scenario.json`, for example:

```json
{
  "pageUrl": "http://127.0.0.1:3100/users",
  "endpoint": "http://127.0.0.1:3100/api/users",
  "storageState": "../private-portal-state.json",
  "readySelector": "[data-testid='user-row']",
  "readyText": "Your test user's name",
  "recovery": "automatic",
  "timeoutMs": 10000
}
```

The ready selector must match exactly **one** visible element. If there are many users, select one exact test row. Selectors are examples, not assumptions about your app. Endpoint must be origin+path without query values; query variants share a fault budget. Only successful main-frame GET fetch/XHR JSON traffic is discovered.

```bash
npx recovery-probe web --config ./portal-discovery/scenario.json --out ./portal-check
```

Optional `--headed` shows the browser. An expired login, wrong endpoint, missing health marker, native request or interception failure is inconclusive—not an automatically confirmed defect. A bounded recovery failure needs investigation against the intended product behavior.

To test a deliberate Retry interaction instead, set `"recovery": "retry"` and `"retrySelector": "..."`. To use your existing Playwright authentication fixture, import `checkDesktop(page, {recovery:'automatic', ...scenario})` from `recovery-probe/desktop`; despite its legacy name, it accepts a standard Playwright Page. The `withFault` API also remains available for custom interactions.

## First test: existing Electron development app

Follow [desktop.md](desktop.md) to start a development app with a loopback debugging port, list windows, discover endpoints and run a configured check. This retains the app's existing login and leaves it open. Set automatic recovery and omit `retrySelector` if there is no Retry button. Native SDK/main-process/IPC requests are outside renderer routing.

These `web`/`desktop` checks never call an AI provider. Read their local reports before proceeding to repair.

## Configure a repair run

The repair runner must launch a **separate build from its own checkout**, not attach to the existing app. Stop whatever is using the configured test port. Commit or stash all changes, including untracked files, in the source repository first. Ignored `.env` files, dependencies and local credentials are not copied into the checkout. Use a disposable dev environment with nonproduction settings. Your configured setup commands must prepare whatever that build needs; secret environment variables are not inherited automatically.

Create `portal-repair.json` in the tools folder, outside the app repository:

```json
{
  "target": "web",
  "repo": "../user-portal",
  "sourceFiles": ["src/features/users/useUsers.ts", "src/features/users/UserList.tsx"],
  "setup": [["npm", "ci"]],
  "launch": ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "3100", "--strictPort"],
  "tests": [["npm", "run", "test", "--", "--run"]],
  "startupTimeoutMs": 60000,
  "commandTimeoutMs": 180000,
  "provider": {"model": "YOUR_RESPONSES_MODEL"},
  "scenario": {
    "pageUrl": "http://127.0.0.1:3100/users",
    "endpoint": "http://127.0.0.1:3100/api/users",
    "storageState": "./private-portal-state.json",
    "readySelector": "[data-testid='the-one-test-user']",
    "readyText": "Your test user's name",
    "recovery": "automatic",
    "timeoutMs": 10000
  }
}
```

Replace source paths, commands, endpoint and selectors with your app's actual ones. The launch example assumes Vite; other frameworks need their own command. Commands are executable/argument arrays, not shell strings. Do not include shell metacharacters. `repo` and `storageState` resolve relative to this config file. Commands execute in the isolated checkout root. An app requiring environment variables can use a reviewed development launch script; the preview does not inherit arbitrary service secrets.

`sourceFiles` is an explicit allowlist of 1–12 small text source files, at most 100 KB each/300 KB total. It is not a whole-repository scanner. Tests/configs, hidden files, traversal and symlink sources are rejected. Include enough of the request/controller/component logic for the model to investigate. Do not include credentials. The model can return exact replacements in those files, not commands, configuration changes or test rewrites.

### Windows commands

The runner uses `shell: false`. Windows `npm.cmd`/`npx.cmd` cannot be launched directly this way. Use the real Node executable plus npm's JavaScript entry point in each command, for example:

```json
["C:/Program Files/nodejs/node.exe", "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js", "run", "dev"]
```

Check your installation paths. Alternatively use a reviewed Node launch script. The CI suite runs on Linux; Windows process handling exists but has not been integration-tested on your desktop.

### Electron repair configuration

Use the same structure with `"target": "desktop"`. Set `scenario.cdp` to an unused loopback debugging port and `scenario.pageUrl` to the renderer URL. `launch` must start the development build from the checkout with remote debugging enabled. A plain Electron project might use:

```json
{
  "target": "desktop",
  "repo": "../desktop-app",
  "sourceFiles": ["src/renderer/profile.ts"],
  "setup": [["npm", "ci"], ["npm", "run", "build"]],
  "launch": ["node", "node_modules/electron/cli.js", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9333", "."],
  "tests": [["npm", "test", "--", "--run"]],
  "manualLogin": true,
  "provider": {"model": "YOUR_RESPONSES_MODEL"},
  "scenario": {
    "cdp": "http://127.0.0.1:9333",
    "pageUrl": "http://127.0.0.1:3100/profile",
    "endpoint": "http://127.0.0.1:3100/api/profile",
    "readySelector": "[data-testid='profile-name']",
    "recovery": "automatic",
    "timeoutMs": 10000
  }
}
```

**Important:** If a source change requires a rebuild, the `launch` script must rebuild on **every** launch (before and after). `setup` runs only once. For Forge or a Rust-backed app, replace the example with the project's existing development/build command. Do not verify a stale compiled artifact. A launch script may orchestrate renderer server and Electron; keep them as child processes so cleanup can terminate them.

Use an isolated Electron profile. The runner sets `RECOVERY_PROBE_USER_DATA_DIR` to a private directory in the run. Your development entry point must honor it before `app.whenReady()`:

```js
if (!app.isPackaged && process.env.RECOVERY_PROBE_USER_DATA_DIR) {
  app.setPath('userData', process.env.RECOVERY_PROBE_USER_DATA_DIR);
}
```

Commit this dev-only integration before preparing the run; it is not something the model adds. The runner cannot force an application to honor this environment variable. Do not reuse a production profile. With `manualLogin: true`, each launch pauses for you to log into the test profile and navigate to the selected screen, then press Enter. The profile persists between before/after runs. This requires an interactive terminal. Rust services and other app-specific data stores need their own development isolation too.

## Run the workflow

First reproduce without uploading anything:

```bash
npx recovery-probe repair --config ./portal-repair.json --out ./portal-repair-run --allow-execution
```

Output must be a new directory outside your source repository. The original repository stays unchanged. Inspect `before.json`, `launch-before.log`, and `repair-request.json`. If the baseline fails or no defect is reproduced, no upload bundle is created and no model is called.

Configure `OPENAI_API_KEY` privately in your terminal and set `provider.model` to a model available to your API account that supports Responses and Structured Outputs. Never paste a key into config/source. API usage may incur provider charges. Employer authorization is required before sending company code.

```bash
npx recovery-probe repair --generate ./portal-repair-run --allow-source-upload
```

This sends the source bundle to `https://api.openai.com/v1/responses`, with `store: false`. Provider retention policy still applies. Only the listed files and bounded observations/expectations are sent—not the full repository, login-state file, screenshots or command logs. The bundle itself can still contain sensitive source/text: inspect it first.

Review `proposal.json` (the explanation and exact find/replace edits). To test the candidate:

```bash
npx recovery-probe repair --verify ./portal-repair-run --allow-execution
```

Verification **executes proposed code**. A checkout is not a security sandbox: use a disposable VM/container for unreviewed code. The model cannot choose shell commands, but application code itself can perform filesystem/network operations. Child processes do not receive `OPENAI_API_KEY` or arbitrary secret environment variables; this does not prevent them reading credentials on disk.

For explicitly authorized unattended runs in a disposable environment, a single command is available:

```bash
npx recovery-probe repair --config ./portal-repair.json --out ./new-run --allow-execution --allow-source-upload --auto-verify
```

`--auto-verify` is explicit consent to execute the unreviewed generated candidate. It still does not alter the original repository or deploy anything.

## Read the result

| Result | Meaning |
| --- | --- |
| No repairable failure reproduced | Baseline/setup was inconclusive, or recovery already passed. No AI diagnosis is attempted. |
| Proposal only | A model hypothesis and edits, not an applied or verified fix. |
| `verified-candidate` | The exact scenario passes after the candidate, supplied tests passed both before and after, and no tracked files changed unexpectedly during verification. Human review remains required. |
| `scenario-passed-tests-missing` | The scenario passed, but no regression test commands were supplied. Not labelled verified. |
| `not-verified` | The scenario, launch, patch integrity or regression tests failed. Do not treat the proposal as a working fix. |

Review `candidate.patch`, `before.json`, `after.json`, `tests-before.json`, `tests-after.json`, and `verification.json`. If you choose to apply a candidate yourself, use `git apply --check` first on the matching base commit, review the patch, and run your normal review/test process. Recovery Probe deliberately does not do that final application for you.

Runs are one-shot; create a new output directory for another attempt. Stop/timeout cleanup targets the process tree the tool launched, not unrelated app processes. POSIX and Windows process handling differ; forcibly detached external services need manual cleanup. Test on local nonproduction services and do not leave remote debugging exposed.

## Privacy and evidence boundaries

Local artifacts include source code, endpoint paths, selectors, expected content, command output, and possibly authenticated state/profiles. Use private permissions/Windows ACLs and delete them when no longer needed. Add tools outputs and auth-state files to your own ignore rules before running near any repository.

The current model adapter follows [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). CI tests its request/response contract with a mock transport, handles refusal/incomplete/error results, and runs real browser/Electron before/after checks using a known fixture edit. **No live-model accuracy, arbitrary-app repair rate, or production safety claim is made.**
