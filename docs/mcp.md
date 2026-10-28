# AI coding agents (MCP)

An AI coding agent can say "this handles a failed request" without ever seeing one fail. `recovery-probe mcp` gives the agent the means to check first. It serves Recovery Probe as [Model Context Protocol](https://modelcontextprotocol.io) tools over stdio, so the agent can fail a read and see what the screen does while it is still writing the code. The same tools work for a developer who drives an agent, and for one who does not use an agent at all: they are the existing checks.

## Add it to an agent

The server runs over stdio: the agent starts `npx -y recovery-probe mcp` and talks to it. Add it wherever your agent keeps its MCP servers. Most agents take this JSON:

```json
{
  "mcpServers": {
    "recovery-probe": { "command": "npx", "args": ["-y", "recovery-probe", "mcp"] }
  }
}
```

Some use a different shape for the same entry. VS Code's `.vscode/mcp.json` uses `servers`:

```json
{
  "servers": {
    "recovery-probe": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "recovery-probe", "mcp"]
    }
  }
}
```

Agents configured with TOML use:

```toml
[mcp_servers.recovery-probe]
command = "npx"
args = ["-y", "recovery-probe", "mcp"]
```

If your agent has an `mcp add` command, give it the name `recovery-probe` and the command `npx -y recovery-probe mcp`.

Install the package in the project, as for the other commands. The browser tools also need Playwright and Chromium:

```bash
npm install --save-dev recovery-probe playwright
npx playwright install chromium
```

Run the server with your project as its working directory (the MCP client’s `cwd` setting, where supported). Install the dependencies in that same project; a temporary `npx` download alone does not install the optional browser dependencies. For a fixed executable path, use `node /absolute/path/to/project/node_modules/recovery-probe/bin/recovery-probe.mjs mcp`. Node.js 22 or newer must be available to the agent.

See [the reproducible MCP demonstration](mcp-demo.md) for a clean installation and a before/after check through the real stdio server.

## Tools

| Tool | What it does |
| --- | --- |
| `find_page_reads` | Opens a page in headless Chromium and lists the JSON GET requests it makes while loading. |
| `check_read_recovery` | Loads the page healthy, fails one GET endpoint with each fault kind, and checks that a data marker comes back by itself or after Retry. It returns an outcome per fault, why the healthy baseline failed if it did, what the screen showed under a fault it didn't recover from, and a report folder with `fix-brief.md` and `reproduce.mjs`. |
| `start_network_faults`, `set_network_faults`, `network_fault_summary`, `stop_network_faults` | Run a [network fault proxy](net.md) for the app's own HTTPS connections, such as an SDK, a main process or a test run started with the returned environment. |
| `find_suspects` | Reads the project's JavaScript and TypeScript, or only what changed since a Git reference, for error handling that can lose data. Each suspect names the read to fail and how to check it. See [Suspect scanner](suspects.md). |
| `compare_reports` | Compares reports of the same check from before and after a change and returns a verdict, what happened to each problem, and a Markdown block for the pull request. A problem counts as gone only when a complete run after the change checked it. See [Before and after](compare.md). |
| `verify_change` | Records the checks of a [verify plan](verify.md) before a change (`baseline: true`), and afterwards reruns them, compares the runs and scans the changed lines for suspects. It answers VERIFIED or NOT_VERIFIED with the reasons. |
| `run_recovery_probe` | Runs `check`, `discover`, `action`, `observe`, `refresh`, `reads`, `windows`, `android --list` or `doctor` with your arguments, for checks that need a configuration file. Examples are discovery in an Electron app and observation with network or file steps. |

A typical loop for a screen that loads data:

1. `find_page_reads` on the page to find its reads.
2. `check_read_recovery` with the read and a selector that matches exactly one element and only shows once the data is on screen. For a list, use its container or a single item.
3. If a fault is caught, read `fix-brief.md`, change the code, and run the same check again.
4. `compare_reports` with the report from step 2 as `before` and the new one as `after` shows whether the change fixed it.

While changing code, `find_suspects` with `changedSince: "main"` points at the reads worth failing.

## Results the agent must report as they are

The server gives the agent these rules when it connects:

- A passing check covers only the configured read and screen marker. It is not proof that the app is resilient.
- `FAULT_NOT_TRIGGERED`, `BASELINE_FAILED` and other inconclusive codes are not passes. Fix the setup and run again.
- When a check can't attach to the app or the IPC hook doesn't answer, run `doctor --json` and follow its fixes.
- Findings such as `LOCAL_FILES_REMOVED` or `DELAYED_UI_UPDATE`, and suspects from `find_suspects`, are leads to investigate, not verdicts. `EXPECTATION_NOT_MET` is different: the app did not show what an `expect` step required.
- Before saying a change fixed something, compare reports of the same check from before and after it with `compare_reports`, and quote its verdict. A run that stopped early is never evidence of a fix.
- With a verify plan, call `verify_change` with `baseline: true` before changing the code, and `verify_change` before saying the change is done; a NOT_VERIFIED change is not done.
- Use development or test apps and accounts only: checks reload pages and fail their reads.

## Limits

- `find_suspects` needs TypeScript in the project.
- The browser tools check reads the page itself makes (fetch and XHR). Native, IPC and service-worker traffic needs the network tools or `run_recovery_probe`.
- Reports go to `.recovery-probe/` in the server's working directory, the agent's project, and are ignored by Git there.
- `run_recovery_probe` runs only Recovery Probe commands. It stops a command after `timeoutMs` (5 minutes by default) or when the client cancels the call.
- The server holds one network fault proxy at a time, and closes it when the client disconnects.
