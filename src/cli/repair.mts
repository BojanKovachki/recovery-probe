import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import {
  prepareRepair,
  generateRepair,
  verifyRepair,
} from '../tools/repair/run.mjs'
import { parseOptions, UsageError } from './args.mjs'

interface RepairOptions {
  'allow-execution'?: true
  'allow-source-upload'?: true
  'auto-verify'?: true
  config?: string
  out?: string
  generate?: string
  verify?: string
}

const USAGE = `Recovery Probe repair preview — local development only
  recovery-probe repair --config repair.json --out NEW_DIRECTORY --allow-execution
  recovery-probe repair --generate RUN_DIRECTORY --allow-source-upload
  recovery-probe repair --verify RUN_DIRECTORY --allow-execution

Optional single run: --config ... --out ... --allow-execution --allow-source-upload --auto-verify

Config: target (web/desktop), repo, sourceFiles, scenario, launch, setup, tests, provider.model.
Paths resolve relative to the config. Output must be outside your clean source repository.
Step 1 clones the committed source locally, starts that copy and reproduces a failure.
Step 2 sends only repair-request.json to OpenAI, using your local OPENAI_API_KEY.
Step 3 applies proposal.json only to the copy and reruns the same scenario and your tests.
Review proposal.json before verification. --auto-verify explicitly executes unreviewed AI code.
A checkout is NOT a security sandbox: use a disposable dev container/VM and test accounts.
There is no implicit source upload, production deployment, commit, merge or original-repo edit.
See docs/repair.md for complete web and Electron examples and Windows commands.`

const OPTIONS = {
  'allow-execution': { type: 'boolean' },
  'allow-source-upload': { type: 'boolean' },
  'auto-verify': { type: 'boolean' },
  config: { type: 'string' },
  out: { type: 'string' },
  generate: { type: 'string' },
  verify: { type: 'string' },
} as const

export async function repairMain(args: string[]) {
  if (!args.length || args.includes('--help')) {
    console.log(USAGE)
    return
  }
  const options = parseOptions(args, OPTIONS).values as RepairOptions
  checkOptions(options)
  const directory = resolve(
    options.generate ??
      options.verify ??
      options.out ??
      `../recovery-probe-run-${Date.now()}`,
  )
  if (options.verify) return verify(directory, options)
  if (options.config && !(await reproduce(options.config, directory, options)))
    return
  await generate(directory, options)
}

function checkOptions(options: RepairOptions) {
  if (
    [options.config, options.generate, options.verify].filter(Boolean)
      .length !== 1
  )
    throw new UsageError('Choose --config, --generate, or --verify')
  if (
    options['auto-verify'] &&
    (!options.config ||
      !options['allow-execution'] ||
      !options['allow-source-upload'])
  )
    throw new UsageError(
      '--auto-verify requires --config, --allow-execution and --allow-source-upload',
    )
}

async function verify(directory: string, options: RepairOptions) {
  const result = await verifyRepair(directory, {
    allowExecution: options['allow-execution'],
  })
  console.log(JSON.stringify(result, null, 2))
  console.log(
    `Review ${directory}/candidate.patch. Your original repository was not modified.`,
  )
  process.exitCode = result.status === 'verified-candidate' ? 0 : 1
}

/** The config with its paths resolved against the config file; prepareRepair validates it. */
async function readRepairConfig(path: string) {
  const configPath = resolve(path)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.repo = resolve(dirname(configPath), config.repo ?? '.')
  if (config.scenario?.storageState)
    config.scenario.storageState = resolve(
      dirname(configPath),
      config.scenario.storageState,
    )
  return config
}

/** Reproduces the failure; true when the run should go on to a proposal. */
async function reproduce(
  configPath: string,
  directory: string,
  options: RepairOptions,
) {
  const config = await readRepairConfig(configPath)
  console.log(
    'Reproducing in a separate checkout; running only the commands you configured.',
  )
  const prepared = await prepareRepair(config, directory, {
    allowExecution: options['allow-execution'],
  })
  if (!prepared.reproduced) {
    console.log(
      `No repairable failure reproduced. Inspect ${directory}/before.json; no model called.`,
    )
    process.exitCode = prepared.before.ok ? 0 : 2
    return false
  }
  console.log(
    `Failure reproduced. Inspect ${directory}/repair-request.json before authorizing source upload.`,
  )
  return Boolean(options['allow-source-upload'])
}

async function generate(directory: string, options: RepairOptions) {
  const proposal = await generateRepair(directory, {
    allowSourceUpload: options['allow-source-upload'],
  })
  console.log(
    `Proposal: ${directory}/proposal.json (${proposal.edits.length} edit(s)). No source changes applied yet.`,
  )
  if (options['auto-verify'] && proposal.edits.length) {
    const result = await verifyRepair(directory, { allowExecution: true })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.status === 'verified-candidate' ? 0 : 1
  } else
    console.log(
      'Review the proposal, then run repair --verify RUN_DIRECTORY --allow-execution.',
    )
}
