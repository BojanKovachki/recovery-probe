# Network faults

Some apps make their own HTTPS requests outside the page: an SDK, the Electron main process or a command-line tool. Recovery Probe's HTTP and IPC faults do not reach them. `recovery-probe net` does, one connection at a time: it runs a loopback HTTPS proxy, the app connects through it, and connections to the hosts you name are refused, reset, stalled or delayed.

## What it can and cannot do

- **Whole connections only.** HTTPS stays end to end, so the proxy sees each connection's host and port and nothing else. It cannot return an HTTP status, change a response or fail one path on a host.
- **The app has to use the proxy.** Clients that read `HTTPS_PROXY` include Rust's reqwest (by default), Go's `net/http`, curl and Python's requests. Node's built-in `fetch` reads it only with `NODE_USE_ENV_PROXY=1` (Node 24 or later). Chromium and Electron renderers ignore it; use the [page's HTTP faults](desktop.md) for those.
- **Open connections are reused.** A rule that starts mid-session reaches a client only once it connects again. Set `dropOpen` to close the open connections to the host when the rule starts.
- It reports what it did to connections, not whether the app recovered. Check the screen with `observe`, discovery or your own assertions.

Use it only with development or test targets you control.

## Run it

`rules.json`:

```json
{
  "rules": [
    { "host": "api.example.com", "fault": "stall", "untilMs": 60000 },
    {
      "host": "*.cdn.example.com",
      "fault": "reset",
      "fromMs": 30000,
      "dropOpen": true
    }
  ]
}
```

```bash
npx recovery-probe net --rules rules.json --port 8899
```

Then start the app with the variables it prints:

```bash
HTTPS_PROXY=http://127.0.0.1:8899 NO_PROXY=localhost,127.0.0.1,::1 your-app
```

In PowerShell, set `$env:HTTPS_PROXY` and `$env:NO_PROXY` before starting the app.

Rule windows count from the first connection through the proxy, so they line up with the app's start. Each faulted connection is printed as it happens. Ctrl+C, or `--duration MS`, stops the proxy and prints how many connections each rule faulted. `--out FILE` saves the report and `--json` prints it: per-host counts and each connection's host, port, outcome and time. Request contents are never seen or stored.

## Rules

| Field | Meaning |
| --- | --- |
| `host` | `api.example.com`, `*.example.com` (subdomains only) or `*` (every host) |
| `fault` | `refuse`: the proxy answers 502, as for an unreachable host. `reset`: accepted, then reset when the TLS handshake starts. `stall`: never answered, so the client's timeout decides. `delay`: connected after `delayMs` |
| `count` | How many connections to fault; every matching one when left out |
| `fromMs`, `untilMs` | When the rule applies |
| `dropOpen` | Close the open connections to the host when the rule starts |

The first rule that matches a connection applies.

## Results

- Exit code 0: every rule faulted at least one connection.
- Exit code 2, `FAULT_NOT_TRIGGERED`: a rule faulted none. Check that the app uses `HTTPS_PROXY` and that the host names match.
- Without `--rules`, the exit code is 0: the run that armed faults through the control reports on them.

## Use it with observe

Without `--rules`, `net` only passes connections through until something arms faults through its control. [`observe --network URL`](observe.md#network-steps) does that from network steps, so the screen is sampled while hosts are away and after they come back. Code can use the same control with `connectNetworkFaults(url)`.

The control listens on the proxy's own loopback address and answers only requests with the `x-recovery-probe: network` header. A web page cannot send that header without a preflight, which the proxy never answers.

## Use it from code

```js
import { startNetworkFaultProxy } from 'recovery-probe/net'

const proxy = await startNetworkFaultProxy()
// Start the app with proxy.env().
proxy.arm([{ host: 'api.example.com', fault: 'refuse', dropOpen: true }])
// Check what the app shows.
proxy.assertApplied() // Throws FAULT_NOT_TRIGGERED when nothing was faulted.
await proxy.close()
```

`arm` replaces the rules and starts their windows. `startNetworkFaultProxy({ rules, armOnFirstConnection: true })` starts them with the first connection, as the command does, and `control: true` enables the control. `dropOpen(host)`, `events()`, `summary()` and `disarm()` are also available.
