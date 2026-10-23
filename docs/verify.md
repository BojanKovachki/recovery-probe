# Verify a change

"Fixed" should mean the check that showed the problem no longer shows it, nothing else got worse, and the new code does not add the failure handling Recovery Probe looks for. `recovery-probe verify` checks all three in one step and says VERIFIED or NOT VERIFIED, so a developer or an AI coding agent has a clear bar to clear before calling a change done.

## The plan

List the checks that prove the change in `.recovery-probe/verify.json`:

```json
{
  "base": "main",
  "runs": 3,
  "checks": [
    {
      "name": "queue",
      "command": ["observe", "--config", "observe.json", "--steps", "steps.json"]
    },
    { "name": "add-contact", "command": ["ipc", "--action", "--config", "action.json"] }
  ]
}
```

- `checks`: 1–20 checks, each a name (letters, digits, `.`, `_`, `-`) and the arguments you would give the CLI. A check needs `--config`, and leaves out `--out`: verify gives every run its own folder.
- `runs`: how often each check runs on each side, 1–10. 3 by default, because a single run can be lucky.
- `base`: the Git reference the change starts from, `main` by default. Only lines changed since it are scanned for suspects.

`--plan FILE` reads the plan from elsewhere.

## Run it

1. Before changing the code, with the app in the state that shows the problem, record the starting point:

   ```bash
   npx recovery-probe verify --baseline
   ```

2. Change the code, restart or reload the app as needed, then:

   ```bash
   npx recovery-probe verify
   ```

Verify reruns every check, compares its runs with the baseline as [`compare`](compare.md) does, and scans the lines changed since `base` for [suspects](suspects.md). The change is **VERIFIED** only when:

- every check **improved**, or stayed **unchanged and clean**: a check that still finds a problem does not verify a fix for it;
- every run after the change is **complete**, and the baseline has a report for the check: an interrupted run proves nothing;
- the check is the one the baseline recorded: a changed command needs a new baseline;
- **no changed line is a suspect**. Prove or dismiss each one, and mark a reviewed line with `// recovery-probe-ignore`. The scan needs TypeScript in the project; without it, the change cannot be verified.

Otherwise it is **NOT VERIFIED**, with one reason per problem. The exit code is 0 when verified, 1 when a check found a new defect, and 2 for anything else to resolve.

Runs are kept in `.recovery-probe/verify/before` and `after`, one folder and log per run. Each `--baseline` replaces the earlier baseline, and each verify replaces the earlier `after` runs. `summary.md` is a block for the pull request, and `summary.json` holds the full result.

## From an AI coding agent

The [MCP server](mcp.md) offers the same steps as `verify_change`: `baseline: true` before the change, and no arguments before saying it is done. Its instructions tell the agent not to call a change done while the verdict is NOT_VERIFIED.

## What it does not cover

Verify is only as good as its plan. It shows that the planned checks improved or stayed clean and that the changed lines add no known data-loss pattern; it does not review style, design or code it has no check for.
