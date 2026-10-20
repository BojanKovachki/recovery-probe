import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  startNetworkFaultProxy,
  validateNetworkRules,
  type NetworkFaultProxy,
} from './net-fault.mjs'
import type { McpTool } from './mcp-server.mjs'

const FAULTS = ['http-error', 'connection-failure', 'invalid-json']
const MAX_OUTPUT = 50_000
const CLI_COMMANDS = ['observe', 'ipc', 'refresh', 'desktop', 'web']

export const MCP_INSTRUCTIONS = `Recovery Probe shows what an app does when a data read fails. Use it to check a claim about error handling before you make it, and quote its results as they are.
- A passing check covers only the configured read and screen marker; it is not proof that the app is resilient.
- FAULT_NOT_TRIGGERED, BASELINE_FAILED and other inconclusive codes are not passes. Fix the setup and run again.
- Findings such as LOCAL_FILES_REMOVED or DELAYED_UI_UPDATE are leads to investigate, not verdicts.
- Use development or test apps and accounts only: checks reload pages and fail their reads.`

const text = (args: Record<string, unknown>, key: string, required = true) => {
  const value = args[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${key} must be a non-empty string`)
  return value
}

const integer = (
  args: Record<string, unknown>,
  key: string,
  [min, max]: [number, number],
) => {
  const value = args[key]
  if (value === undefined) return undefined
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`${key} must be an integer from ${min} to ${max}`)
  return value as number
}

// Playwright is an optional peer dependency, needed only by the browser tools.
const loadWeb = async () => {
  try {
    return await import('./web.mjs')
  } catch (error) {
    throw new Error(
      `The browser tools need Playwright: npm install --save-dev playwright && npx playwright install chromium (${(error as Error).message})`,
      { cause: error },
    )
  }
}

/** A new private directory under .recovery-probe for one run's reports. */
const reportDirectory = async (kind: string) => {
  const directory = resolve(
    '.recovery-probe',
    `mcp-${kind}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  return directory
}

const truncated = (value: string) =>
  value.length > MAX_OUTPUT
    ? `${value.slice(0, MAX_OUTPUT)}\n[truncated ${value.length - MAX_OUTPUT} characters]`
    : value

const findPageReads: McpTool = {
  name: 'find_page_reads',
  title: 'Find the reads behind a page',
  description:
    'Opens a page in headless Chromium and lists the JSON GET requests it makes while it loads. Use it to choose the endpoint for check_read_recovery. Only successful page fetch and XHR reads are seen; native, IPC and service-worker traffic is not.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Page of a development or test app.',
      },
      durationMs: {
        type: 'integer',
        minimum: 200,
        maximum: 30000,
        default: 5000,
        description: 'How long to watch after the page loads.',
      },
      storageState: {
        type: 'string',
        description:
          'Playwright storage state file of a signed-in test account.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args) {
    const { discoverWeb } = await loadWeb()
    return discoverWeb(
      {
        pageUrl: text(args, 'url')!,
        storageState: text(args, 'storageState', false),
      },
      { durationMs: integer(args, 'durationMs', [200, 30000]) },
    )
  },
}

const checkReadRecovery: McpTool = {
  name: 'check_read_recovery',
  title: 'Check that a page recovers when a read fails',
  description:
    'Loads the page healthy, then fails one GET endpoint with each fault kind and checks that the ready marker comes back: by itself (recovery "automatic") or after clicking retrySelector ("retry"). Returns an outcome per fault and the report folder, which includes fix-brief.md and reproduce.mjs.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Page of a development or test app.',
      },
      endpoint: {
        type: 'string',
        description:
          'Origin and path of the GET read to fail, as find_page_reads lists it.',
      },
      readySelector: {
        type: 'string',
        description:
          'CSS selector of an element that is visible only once that read has rendered its data.',
      },
      readyText: {
        type: 'string',
        description: 'Text the ready element must contain.',
      },
      recovery: {
        type: 'string',
        enum: ['automatic', 'retry'],
        default: 'automatic',
      },
      retrySelector: {
        type: 'string',
        description: 'Required when recovery is "retry".',
      },
      faults: {
        type: 'array',
        items: { type: 'string', enum: FAULTS },
        description: `Which faults to apply; all of ${FAULTS.join(', ')} by default.`,
      },
      times: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        default: 1,
        description: 'How many consecutive requests each fault fails.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 200,
        maximum: 60000,
        default: 5000,
      },
      storageState: { type: 'string' },
    },
    required: ['url', 'endpoint', 'readySelector'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async run(args) {
    const { checkWeb } = await loadWeb()
    const { writeDesktopReport } = await import('./desktop-report.mjs')
    const scenario = {
      target: 'web',
      pageUrl: text(args, 'url')!,
      endpoint: text(args, 'endpoint')!,
      readySelector: text(args, 'readySelector')!,
      recovery: (text(args, 'recovery', false) ?? 'automatic') as
        'automatic' | 'retry',
      ...(args.readyText !== undefined
        ? { readyText: text(args, 'readyText') }
        : {}),
      ...(args.retrySelector !== undefined
        ? { retrySelector: text(args, 'retrySelector') }
        : {}),
      ...(args.faults !== undefined ? { faults: args.faults as string[] } : {}),
      ...(args.times !== undefined
        ? { times: integer(args, 'times', [1, 10]) }
        : {}),
      ...(args.timeoutMs !== undefined
        ? { timeoutMs: integer(args, 'timeoutMs', [200, 60000]) }
        : {}),
      ...(args.storageState !== undefined
        ? { storageState: text(args, 'storageState') }
        : {}),
    }
    const report = await checkWeb(scenario as Parameters<typeof checkWeb>[0])
    const directory = await reportDirectory('check')
    await writeDesktopReport(directory, report, scenario)
    return {
      ok: report.ok,
      results: report.results.map(
        ({ kind, outcome, code, applied, recoveryMs }) => ({
          kind,
          outcome,
          code,
          applied,
          ...(recoveryMs === undefined ? {} : { recoveryMs }),
        }),
      ),
      limitation: report.limitation,
      report: join(directory, 'report.json'),
      fixBrief: join(directory, 'fix-brief.md'),
    }
  },
}

let proxy: NetworkFaultProxy | undefined

const ruleSchema = {
  type: 'object',
  properties: {
    host: {
      type: 'string',
      description: 'api.example.com, *.example.com or *.',
    },
    fault: { type: 'string', enum: ['refuse', 'reset', 'stall', 'delay'] },
    delayMs: { type: 'integer', minimum: 0 },
    count: { type: 'integer', minimum: 1 },
    fromMs: { type: 'integer', minimum: 0 },
    untilMs: { type: 'integer', minimum: 1 },
    dropOpen: { type: 'boolean' },
  },
  required: ['host', 'fault'],
  additionalProperties: false,
}

const networkTools: McpTool[] = [
  {
    name: 'start_network_faults',
    title: 'Start a network fault proxy',
    description:
      "Starts a loopback HTTPS proxy for an app's own connections (an SDK, a main process, a CLI or a test run). Start the app or tests with the returned environment; connections pass until set_network_faults arms rules. Faults apply to whole connections per host: HTTPS stays end to end.",
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'integer', minimum: 0, maximum: 65535 } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    async run(args) {
      proxy ??= await startNetworkFaultProxy({
        port: integer(args, 'port', [0, 65535]),
      })
      return { url: proxy.url, env: proxy.env() }
    },
  },
  {
    name: 'set_network_faults',
    title: 'Arm or remove network faults',
    description:
      'Replaces the armed rules, or removes them all with restore: true. Windows count from this call. Set dropOpen on a rule so clients that keep connections open have to reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        rules: { type: 'array', items: ruleSchema },
        restore: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args) {
      if (!proxy) throw new Error('Call start_network_faults first')
      if (args.restore === true) {
        proxy.disarm()
        return { armed: [] }
      }
      const rules = validateNetworkRules(args.rules)
      proxy.arm(rules)
      return { armed: rules }
    },
  },
  {
    name: 'network_fault_summary',
    title: 'Show what the network faults did',
    description:
      'Reports how many connections went through the proxy and, for the armed rules, how many each matched and faulted. A rule that faulted nothing means the app did not use the proxy or the host name is wrong.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run() {
      if (!proxy) throw new Error('Call start_network_faults first')
      return proxy.summary()
    },
  },
  {
    name: 'stop_network_faults',
    title: 'Stop the network fault proxy',
    description:
      'Removes every fault, closes the proxy and returns its final summary.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run() {
      if (!proxy) return { stopped: false }
      const closing = proxy
      proxy = undefined
      await closing.close()
      return { stopped: true, ...closing.summary() }
    },
  },
]

const runCli: McpTool = {
  name: 'run_recovery_probe',
  title: 'Run a Recovery Probe command',
  description: `Runs a Recovery Probe command that has no dedicated tool, such as observe (with --steps, --network or --files), ipc discovery, refresh, or desktop attachment, and returns its exit code and output. Commands: ${CLI_COMMANDS.join(', ')}. Pass --json where the command supports it. See the package docs for each command's configuration.`,
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
    const timeoutMs = integer(args, 'timeoutMs', [1000, 900000]) ?? 300000
    const cli = fileURLToPath(
      new URL('../bin/recovery-probe.mjs', import.meta.url),
    )
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

export const recoveryProbeTools: McpTool[] = [
  findPageReads,
  checkReadRecovery,
  ...networkTools,
  runCli,
]

/** Closes what the tools left running, such as the network proxy. */
export async function closeRecoveryProbeTools(): Promise<void> {
  if (proxy) {
    const closing = proxy
    proxy = undefined
    await closing.close()
  }
}
