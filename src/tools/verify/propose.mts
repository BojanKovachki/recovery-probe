// Proposes project checks from a project's own configuration. It reads files and nothing else:
// nothing here can start a process, so a proposal can never run what it proposes.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isRecord } from '../../core/validate.mjs'

export interface ProposedCheck {
  id: string
  command: string[]
  inputs: string[]
  timeoutMs: number
  /** The file each proposal rests on, and the text it quotes. */
  evidence: { file: string; text?: string }[]
}

export interface Proposals {
  setup: { command: string[]; evidence: { file: string }[] }[]
  projectChecks: ProposedCheck[]
  /** What detection couldn't decide: a person settles each. */
  ambiguities: string[]
  note: string
}

const NOTE =
  'Proposals only: nothing was run. Copy the commands you approve into the policy; they become approved once merged into the base.'
const NPM_PLACEHOLDER = '/path/to/npm-cli.js'
const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
]
const TOOLS =
  /\b(tsc|eslint|vitest|jest|mocha|ava|tap|biome|playwright test|node --test)\b/
const RUNNERS = [
  { tool: 'vitest', configs: ['vitest.config'], args: ['run'] },
  { tool: 'jest', configs: ['jest.config'], args: [] },
  {
    tool: 'playwright',
    configs: ['playwright.config'],
    args: ['test'],
    pkg: '@playwright/test',
  },
]
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json']

/** npm's own CLI file, which runs without a shell: through Node, as on Windows it must. */
function npmCli() {
  const node = dirname(process.execPath)
  return [
    process.env.npm_execpath,
    join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(node, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((path) => path?.endsWith('npm-cli.js') && existsSync(path))
}

const readJson = async (path: string) => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Why a script can't be approved as it is, or undefined when it can. */
function scriptProblem(name: string, body: string) {
  if (/&&|\|\||\||;/.test(body))
    return `scripts.${name} chains commands ("${body}"), which a command without a shell can't run: approve its parts separately`
  if (/^\s*\w+=|cross-env/.test(body))
    return `scripts.${name} sets environment variables ("${body}"): name them in the policy's env and approve the command itself`
  if (
    /\b(serve|dev|start|watch)\b/.test(name) ||
    /--watch|\bserve\b/.test(body)
  )
    return `scripts.${name} starts a server or watches ("${body}"): a check must end on its own`
  return undefined
}

/** Proposals for package.json scripts that run a type checker, linter or test runner. */
function fromScripts(
  scripts: Record<string, unknown>,
  npm: string,
  found: Proposals,
) {
  const tests = Object.keys(scripts).filter((name) => /test/.test(name))
  if (tests.length > 1)
    found.ambiguities.push(
      `several test scripts (${tests.join(', ')}): approve the ones that matter`,
    )
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue
    if (
      !TOOLS.test(body) &&
      !['test', 'lint', 'typecheck', 'type-check'].includes(name)
    )
      continue
    const problem = scriptProblem(name, body)
    if (problem) {
      found.ambiguities.push(problem)
      continue
    }
    found.projectChecks.push({
      id: name.replace(/[^\w.-]/g, '-').slice(0, 40),
      command: ['node', npm, 'run', name],
      inputs: [`package.json#scripts.${name}`],
      timeoutMs: /test/.test(name) ? 600000 : 300000,
      evidence: [{ file: 'package.json', text: `"${name}": "${body}"` }],
    })
  }
}

/** A test runner's configuration, when no script already runs that runner. */
async function fromRunners(
  root: string,
  scripts: Record<string, unknown>,
  found: Proposals,
) {
  const scripted = Object.values(scripts).join(' ')
  for (const { tool, configs, args, pkg = tool } of RUNNERS) {
    const config = configs
      .flatMap((name) => EXTENSIONS.map((extension) => `${name}${extension}`))
      .find((file) => existsSync(join(root, file)))
    if (!config || scripted.includes(tool)) continue
    const manifest = await readJson(
      join(root, 'node_modules', pkg, 'package.json'),
    )
    const bin = isRecord(manifest) ? manifest.bin : undefined
    const entry =
      typeof bin === 'string' ? bin : isRecord(bin) ? bin[tool] : undefined
    if (typeof entry !== 'string') {
      found.ambiguities.push(
        `${config} configures ${tool}, which isn't installed here: run setup, then propose again`,
      )
      continue
    }
    found.projectChecks.push({
      id: tool,
      command: [
        'node',
        join('node_modules', pkg, entry).split('\\').join('/'),
        ...args,
      ],
      inputs: [config],
      timeoutMs: 600000,
      evidence: [{ file: config }],
    })
  }
}

/** A type check and a lint run from their configuration files, unless a script already runs them. */
function fromConfigs(root: string, scripted: string, found: Proposals) {
  if (existsSync(join(root, 'tsconfig.json')) && !/\btsc\b/.test(scripted))
    found.projectChecks.push({
      id: 'typecheck',
      command: [
        'node',
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '-p',
        'tsconfig.json',
      ],
      inputs: ['tsconfig.json'],
      timeoutMs: 300000,
      evidence: [{ file: 'tsconfig.json' }],
    })
  const eslint = ESLINT_CONFIGS.find((file) => existsSync(join(root, file)))
  if (eslint && !/\beslint\b/.test(scripted))
    found.projectChecks.push({
      id: 'lint',
      command: ['node', 'node_modules/eslint/bin/eslint.js', '.'],
      inputs: [eslint],
      timeoutMs: 300000,
      evidence: [{ file: eslint }],
    })
}

/** Setup from the lockfile: npm's, which a policy can run; others need writing by hand. */
function fromLockfiles(root: string, npm: string, found: Proposals) {
  const npmLock = ['package-lock.json', 'npm-shrinkwrap.json'].find((file) =>
    existsSync(join(root, file)),
  )
  if (npmLock)
    found.setup.push({
      command: ['node', npm, 'ci', '--ignore-scripts'],
      evidence: [{ file: npmLock }],
    })
  for (const file of ['yarn.lock', 'pnpm-lock.yaml'])
    if (existsSync(join(root, file)))
      found.ambiguities.push(
        `${file}: write the setup command by hand, through Node and the package manager's JavaScript file`,
      )
}

/** Proposes setup and project checks for the project at `root`, with the evidence for each. */
export async function proposeChecks(root: string): Promise<Proposals> {
  const found: Proposals = {
    setup: [],
    projectChecks: [],
    ambiguities: [],
    note: NOTE,
  }
  const npm = npmCli() ?? NPM_PLACEHOLDER
  const manifest = await readJson(join(root, 'package.json'))
  const scripts =
    isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {}
  fromScripts(scripts, npm, found)
  // A tool only a rejected script runs still gets its own proposal.
  const proposed = found.projectChecks.flatMap(({ evidence }) =>
    evidence.map(({ text = '' }) => text),
  )
  fromConfigs(root, proposed.join(' '), found)
  await fromRunners(root, scripts, found)
  fromLockfiles(root, npm, found)
  if (
    npm === NPM_PLACEHOLDER &&
    JSON.stringify(found).includes(NPM_PLACEHOLDER)
  )
    found.ambiguities.push(
      `npm's CLI file wasn't found: replace ${NPM_PLACEHOLDER} with its path`,
    )
  return found
}
