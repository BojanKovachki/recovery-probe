# A retry that looks right but does nothing

A healthy screen cannot prove that Retry works. This demonstration uses a synthetic profile page whose controller leaves its `pending` flag set when a request fails. The error message and Retry button appear, but clicking Retry returns immediately. The corrected controller clears `pending` in `finally`, allowing the next read to run.

The [controller](../examples/profile-controller.mjs) and [app](../examples/demo-server.mjs) are included in the npm package. The demonstration starts the real `recovery-probe mcp` process, performs the MCP handshake and calls its tools over stdio. No AI model, API key or external app is involved.

## Run from a clean project

Use Node.js 22 or newer, then:

```bash
mkdir recovery-probe-example
cd recovery-probe-example
npm init -y
npm install --save-dev recovery-probe playwright
npx playwright install chromium
node node_modules/recovery-probe/examples/mcp-demo.mjs
```

From a source checkout, use `npm ci`, `npx playwright install chromium`, then `npm run demo:mcp`.

The demonstration:

1. Discovers the profile GET request with `find_page_reads`.
2. Checks the broken controller with `check_read_recovery`. Each experiment first requires a healthy data marker, then injects a 503, a dropped connection or malformed JSON and clicks Retry.
3. Repeats the same checks against the corrected controller.
4. Calls `compare_reports` and requires `IMPROVED`, with all three failures marked `GONE`.

It exits unsuccessfully if the broken page passes, the corrected page fails, any fault is not applied, or the comparison does not match. The detailed tool results are saved in `artifacts/mcp-demo.json`; individual reports, reproduction scripts and fix briefs are under `.recovery-probe/`.

This is a controlled comparison of two supplied implementations, not an autonomous agent repairing an unknown bug. The passing result covers these reads, markers and faults only. It does not establish overall resilience or prove that fabricated data cannot satisfy a poorly chosen marker. Use checks tied to the data your users actually need.
