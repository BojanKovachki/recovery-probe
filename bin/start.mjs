import { createInterface } from 'node:readline/promises';
import { parseStartArgs, runStart } from '../src/guided-start.mjs';

export async function startMain(args) {
  if (!args.length || args.includes('--help')) {
    console.log(`Recovery Probe guided start
  recovery-probe start web [URL] [--fresh] [--headless] [--dir FOLDER]
  recovery-probe start desktop [--cdp http://127.0.0.1:9222] [--fresh] [--dir FOLDER]

First run: sign in, choose a request if needed, click loaded content, confirm recovery.
The browser download, discovery, configuration and reports are handled automatically.
Rerun the same command to reuse local setup. --fresh replaces setup and refreshes login.
--headless is for saved web checks only. Use a separate --dir for each scenario.
Electron must already expose its loopback development debugging port.
Local checks only: no source upload or AI repair. Native/Rust/IPC traffic is not covered.`);
    return;
  }
  const options = parseStartArgs(args);
  let terminal;
  const io = {
    interactive: Boolean(process.stdin.isTTY),
    log: text => console.log(text),
    ask: async prompt => {
      if (!process.stdin.isTTY) throw new Error('This choice requires an interactive terminal.');
      terminal ??= createInterface({ input: process.stdin, output: process.stdout });
      return terminal.question(prompt);
    },
  };
  try { process.exitCode = (await runStart(options, io)).exitCode; }
  finally { terminal?.close(); }
}
