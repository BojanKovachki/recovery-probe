import type { ParseArgsOptionsConfig } from 'node:util'
import { version } from '../core/package.mjs'
import { parseOptions, UsageError, type Values } from './args.mjs'

/** A command whose flags main parses from its option spec. */
interface ParsedCommand {
  usage: string
  options: ParseArgsOptionsConfig
  positionals?: number
  run(values: Values, positionals: string[]): Promise<void>
}

// Commands that still read their own arguments, including --help.
type RawCommand = (args: string[]) => Promise<void>

interface Entry {
  summary: string
  load: () => Promise<ParsedCommand | RawCommand>
}

const raw =
  <K extends string>(
    load: () => Promise<Record<K, RawCommand>>,
    name: K,
  ): (() => Promise<RawCommand>) =>
  async () =>
    (await load())[name]

const groups: [string, Record<string, Entry>][] = [
  [
    'Get started',
    {
      init: {
        summary: 'Find what to test and run a first check',
        load: raw(() => import('./init.mjs'), 'initMain'),
      },
      doctor: {
        summary: "Check the setup and say how to fix what's missing",
        load: raw(() => import('./doctor.mjs'), 'doctorMain'),
      },
      demo: {
        summary: 'Run the built-in broken and fixed app',
        load: () => import('./demo.mjs'),
      },
      start: {
        summary: 'Guided check of a web app or an Electron window',
        load: raw(() => import('./start.mjs'), 'startMain'),
      },
    },
  ],
  [
    'Test recovery',
    {
      check: {
        summary: 'Fail one read and check that the screen comes back',
        load: () => import('./check.mjs'),
      },
      discover: {
        summary: 'Fail a read in a few ways and compare with healthy runs',
        load: () => import('./discover.mjs'),
      },
      refresh: {
        summary: 'Fail a read when a loaded screen refreshes',
        load: raw(() => import('./refresh.mjs'), 'refreshMain'),
      },
      observe: {
        summary: 'Watch reads and the screen without faults',
        load: raw(() => import('./observe.mjs'), 'observeMain'),
      },
      action: {
        summary: 'Check what users see when a save or send fails',
        load: () => import('./action.mjs'),
      },
      net: {
        summary: "Fail an app's own HTTPS connections, such as an SDK's",
        load: raw(() => import('./net.mjs'), 'netMain'),
      },
    },
  ],
  [
    'Find what to test',
    {
      windows: {
        summary: 'List the windows on a debugging port',
        load: () => import('./windows.mjs'),
      },
      reads: {
        summary: 'List the JSON reads a page makes while it loads',
        load: () => import('./reads.mjs'),
      },
      login: {
        summary: 'Save a browser login for later checks',
        load: () => import('./login.mjs'),
      },
      android: {
        summary: 'Make an Android WebView reachable on a local port',
        load: raw(() => import('./android.mjs'), 'androidMain'),
      },
    },
  ],
  [
    'Work on a fix',
    {
      suspects: {
        summary: 'Find code that turns a failed read into "no data"',
        load: raw(() => import('./suspects.mjs'), 'suspectsMain'),
      },
      compare: {
        summary: 'Compare the same check from before and after a change',
        load: raw(() => import('./compare.mjs'), 'compareMain'),
      },
      watch: {
        summary: 'Rerun a check and the suspect scan on every save',
        load: raw(() => import('./watch.mjs'), 'watchMain'),
      },
      verify: {
        summary: 'Say whether a change is done',
        load: raw(() => import('./verify.mjs'), 'verifyMain'),
      },
      repair: {
        summary: 'Propose and verify a source change with a model (opt-in)',
        load: raw(() => import('./repair.mjs'), 'repairMain'),
      },
    },
  ],
  [
    'Agents',
    {
      mcp: {
        summary: 'Serve the checks to coding agents over MCP',
        load: raw(() => import('./mcp.mjs'), 'mcpMain'),
      },
    },
  ],
]
const commands: Record<string, Entry> = Object.assign(
  {},
  ...groups.map(([, entries]) => entries),
)

function help(): string {
  const width = Math.max(...Object.keys(commands).map((name) => name.length))
  const sections = groups.map(
    ([title, entries]) =>
      `${title}\n${Object.entries(entries)
        .map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`)
        .join('\n')}`,
  )
  return `Recovery Probe ${version}

Usage: recovery-probe <command> [options]

${sections.join('\n\n')}

Examples:
  recovery-probe init http://localhost:3000
  recovery-probe check --config scenario.json
  recovery-probe discover --config discover.json --screenshots

Run recovery-probe <command> --help for its options.
Exit codes: 0 passed, 1 a check failed, 2 needs review or inconclusive,
3 wrong usage or config, 4 couldn't run.`
}

async function runCommand(name: string, args: string[]): Promise<void> {
  const command = await commands[name].load()
  if (typeof command === 'function') return command(args)
  if (args.includes('--help')) {
    console.log(command.usage)
    return
  }
  const { values, positionals } = parseOptions(
    args,
    command.options,
    command.positionals,
  )
  return command.run(values, positionals)
}

// The commands 1.0 replaced, so someone used to them learns the new names.
const REPLACED: Record<string, string> = {
  desktop: 'windows, reads and check',
  web: 'login, reads, check, discover and windows',
  ipc: 'check, discover and action',
  '--demo': 'demo',
  '--config': 'check --config',
}

async function main(argv: string[]): Promise<void> {
  if (
    !argv.length ||
    (argv.length === 1 && ['--help', '-h'].includes(argv[0]))
  ) {
    console.log(help())
    return
  }
  if (argv.length === 1 && argv[0] === '--version') {
    console.log(version)
    return
  }
  if (Object.hasOwn(commands, argv[0]))
    return runCommand(argv[0], argv.slice(1))
  const replaced = Object.hasOwn(REPLACED, argv[0])
    ? ` 1.0 replaced it with ${REPLACED[argv[0]]}.`
    : ''
  throw new UsageError(
    `Unknown command: ${argv[0]}.${replaced} Run recovery-probe --help.`,
  )
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(`Recovery Probe: ${(error as Error).message}`)
  process.exitCode = error instanceof UsageError ? 3 : 4
}
