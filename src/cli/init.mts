import { access, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CDP_FLAGS } from '../tools/doctor.mjs'
import { runStart } from '../tools/start/run.mjs'
import {
  chooseIpcScenario,
  detectTarget,
  type InitTarget,
} from '../tools/init.mjs'
import { run as discover } from './discover.mjs'
import { terminalIo } from './terminal.mjs'
import { parseOptions, text, UsageError } from './args.mjs'

const HELP = `recovery-probe init [URL] [--cdp URL] [--inspector URL] [--dir FOLDER] [--fresh]

Finds what to test and runs a first check:
  URL                    your web app, opened in a browser for the guided check
  an app on --cdp        an Electron app or browser to attach to (default http://127.0.0.1:9222)
  the hook on --inspector an Electron app that loads data over IPC (default http://127.0.0.1:9229)

Run it again to repeat the same check, or add --fresh to set it up again.
recovery-probe doctor shows what's missing.`

interface InitOptions {
  url?: string
  cdp?: string
  inspector?: string
  dir?: string
  fresh?: true
}

const NOTHING_TO_TEST = `Nothing to test yet. Either:
  - give it your web app's URL: npx recovery-probe init http://localhost:3000
  - start your Electron app with ${CDP_FLAGS}, then run init again
  - for an Electron app that loads data over IPC, also load the hook: recovery-probe doctor shows how`

function parseInitArgs(args: string[]): InitOptions {
  const { values, positionals } = parseOptions(
    args,
    {
      fresh: { type: 'boolean' },
      cdp: { type: 'string' },
      inspector: { type: 'string' },
      dir: { type: 'string' },
    },
    1,
  )
  const options: InitOptions = {
    url: positionals[0],
    cdp: text(values, 'cdp'),
    inspector: text(values, 'inspector'),
    dir: text(values, 'dir'),
    ...(values.fresh ? { fresh: true as const } : {}),
  }
  if (options.url && (options.cdp || options.inspector))
    throw new UsageError('Give either a URL or --cdp and --inspector, not both')
  return options
}

export async function initMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const options = parseInitArgs(args)
  const target = await detectTarget(options)
  if (target.kind === 'none') {
    console.log(NOTHING_TO_TEST)
    process.exitCode = 2
    return
  }
  if (target.kind === 'ipc') return initIpc(target, options)
  if (target.kind === 'desktop' && target.hookError)
    console.log(
      `There's a Node inspector, but no IPC hook answered (${target.hookError}). Testing the window's HTTP reads instead; recovery-probe doctor shows how to set up IPC.`,
    )
  const io = terminalIo()
  try {
    const saved = { fresh: options.fresh, dir: options.dir }
    const { exitCode } = await runStart(
      target.kind === 'web'
        ? { target: 'web', url: target.url, ...saved }
        : { target: 'desktop', cdp: target.cdp, ...saved },
      io,
    )
    process.exitCode = exitCode
  } finally {
    io.close()
  }
}

// The first run saves the chosen channels; later runs reuse them.
async function initIpc(
  target: Extract<InitTarget, { kind: 'ipc' }>,
  options: InitOptions,
) {
  const directory = resolve(
    options.dir ?? join('.recovery-probe', 'init', 'ipc'),
  )
  const configPath = join(directory, 'discover.json')
  const saved =
    !options.fresh &&
    (await access(configPath).then(
      () => true,
      () => false,
    ))
  if (saved)
    console.log(
      `Using the channels saved in ${configPath}. Add --fresh to choose again.`,
    )
  else {
    const io = terminalIo()
    try {
      if (!io.interactive)
        throw new Error('The first setup needs an interactive terminal.')
      io.log(
        `Found an Electron app with the Recovery Probe hook ${target.identity.version}.`,
      )
      const config = await chooseIpcScenario(target.identity, io, target)
      await io.ask('Open that screen in the app, then press Enter here: ')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
      await writeFile(configPath, JSON.stringify(config, null, 2), {
        mode: 0o600,
      })
    } finally {
      io.close()
    }
  }
  await discover({ config: configPath })
}
