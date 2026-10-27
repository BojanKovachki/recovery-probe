import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packageUrl } from '../../core/package.mjs'
import { integer, truncated } from './args.mjs'
import type { McpTool } from './server.mjs'

// The old ipc, desktop and web spellings still run until 1.0.
const CLI_COMMANDS = [
  'check',
  'discover',
  'action',
  'reads',
  'windows',
  'observe',
  'refresh',
  'android',
  'doctor',
  'ipc',
  'desktop',
  'web',
]

export const runCli: McpTool = {
  name: 'run_recovery_probe',
  title: 'Run a Recovery Probe command',
  description: `Runs a Recovery Probe command that has no dedicated tool, such as check and discover for an Electron app or an attached browser, action, observe (with --steps, --network or --files), refresh, reads, windows, android --list or doctor (setup checks), and returns its exit code and output. Commands: ${CLI_COMMANDS.join(', ')}. Pass --json where the command supports it. See the package docs for each command's configuration.`,
  inputSchema: {
    type: 'object',
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'Command and arguments, for example ["observe", "--config", "observe.json", "--json"].',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1000,
        maximum: 900000,
        default: 300000,
      },
    },
    required: ['args'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  async run(args, { signal }) {
    const argv = args.args
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      argv.some((a) => typeof a !== 'string')
    )
      throw new Error('args must be a non-empty list of strings')
    if (!CLI_COMMANDS.includes(argv[0]))
      throw new Error(`The command must be one of ${CLI_COMMANDS.join(', ')}`)
    // A forward stays open until stopped; only listing is a bounded call.
    if (argv[0] === 'android' && !argv.includes('--list'))
      throw new Error(
        'Only android --list can run here; run the forward in a terminal',
      )
    const timeoutMs = integer(args, 'timeoutMs', [1000, 900000]) ?? 300000
    // A separate process can be killed on timeout or cancel; the server keeps running.
    const cli = fileURLToPath(packageUrl('bin/recovery-probe.mjs'))
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
        timeout: timeoutMs,
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('error', (error) =>
        reject(
          new Error(`Could not run the command: ${error.message}`, {
            cause: error,
          }),
        ),
      )
      child.on('close', (exitCode, killedBy) =>
        resolve({
          exitCode,
          ...(killedBy ? { stoppedBy: killedBy } : {}),
          stdout: truncated(stdout),
          stderr: truncated(stderr),
        }),
      )
    })
  },
}
