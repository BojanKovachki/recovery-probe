# AI coding agents (MCP) (0.5.0-preview.12)

An AI coding agent can say "this handles a failed request" without ever seeing one fail. `recovery-probe mcp` gives the agent the means to check first. It serves Recovery Probe as [Model Context Protocol](https://modelcontextprotocol.io) tools over stdio, so the agent can fail a read and see what the screen does while it is still writing the code. The same tools work for a developer who drives an agent, and for one who does not use an agent at all: they are the existing checks.

## Add it to an agent

Claude Code:

```bash
claude mcp add recovery-probe -- npx recovery-probe mcp
```

Other clients that take a JSON configuration:

```json
{
  "mcpServers": {
    "recovery-probe": { "command": "npx", "args": ["recovery-probe", "mcp"] }
  }
}
```

Install the package in the project, as for the other commands. The browser tools also need Playwright and Chromium:

```bash
npm install --save-dev recovery-probe playwright
npx playwright install chromium
```

## Tools

| Tool | What it does |
| --- | --- |
| `find_page_reads` | Opens a page in headless Chromium and lists the JSON GET requests it makes while loading. |
| `check_read_recovery` | Loads the page healthy, fails one GET endpoint with each fault kind, and checks that a data marker comes back by itself or after Retry. It returns an outcome per fault and a report folder with `fix-brief.md` and `reproduce.mjs`. |
| `start_network_faults`, `set_network_faults`, `network_fault_summary`, `stop_network_faults` | Run a [network fault proxy](net.md) for the app's own HTTPS connections, such as an SDK, a main process or a test run started with the returned environment. |
| `find_suspects` | Reads the project's JavaScript and TypeScript, or only what changed since a Git reference, for error handling that can lose data. Each suspect names the read to fail and how to check it. See [Suspect scanner](suspects.md). |
| `run_recovery_probe` | Runs `observe`, `ipc`, `refresh`, `desktop`, `web` or `android --list` with your arguments, for checks that need a configuration file. Examples are observation with network steps or `--files`, and IPC discovery in an Electron app. |

A typical loop for a screen that loads data:

1. `find_page_reads` on the page to find its reads.
2. `check_read_recovery` with the read and a selector that only shows once the data is on screen.
3. If a fault is caught, read `fix-brief.md`, change the code, and run the same check again.

While changing code, `find_suspects` with `changedSince: "main"` points at the reads worth failing.

## Results the agent must report as they are

The server gives the agent these rules when it connects:

- A passing check covers only the configured read and screen marker. It is not proof that the app is resilient.
- `FAULT_NOT_TRIGGERED`, `BASELINE_FAILED` and other inconclusive codes are not passes. Fix the setup and run again.
- Findings such as `LOCAL_FILES_REMOVED` or `DELAYED_UI_UPDATE`, and suspects from `find_suspects`, are leads to investigate, not verdicts.
- Use development or test apps and accounts only: checks reload pages and fail their reads.

## Limits

- `find_suspects` needs TypeScript in the project.
- The browser tools check reads the page itself makes (fetch and XHR). Native, IPC and service-worker traffic needs the network tools or `run_recovery_probe`.
- Reports go to `.recovery-probe/` in the server's working directory, the agent's project, and are ignored by Git there.
- `run_recovery_probe` runs only Recovery Probe commands. It stops a command after `timeoutMs` (5 minutes by default) or when the client cancels the call.
- The server holds one network fault proxy at a time, and closes it when the client disconnects.
