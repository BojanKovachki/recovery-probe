import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import {
  resolve,
  join,
  dirname,
  basename,
  relative,
  isAbsolute,
  sep,
} from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { connect as netConnect } from 'node:net'
import type { Browser, Page } from 'playwright'
import { checkWeb, type WebConfig } from './web.mjs'
import {
  connectDesktop,
  selectDesktopPage,
  checkDesktop,
  validateDesktopConfig,
  type DesktopConfig,
  type DesktopReport,
  type ValidDesktopConfig,
} from './desktop.mjs'
import {
  proposeRepair,
  type RepairEdit,
  type RepairProposal,
} from './repair-provider.mjs'
import {
  runCommand,
  startCommand,
  validateCommand,
  type CommandResult,
} from './repair-process.mjs'

/** A repair run's configuration, validated: what to launch, test and read. */
export interface RepairConfig {
  target: 'web' | 'desktop'
  repo: string
  sourceFiles: string[]
  launch: string[]
  setup?: string[][]
  tests?: string[][]
  scenario: ValidDesktopConfig &
    Pick<WebConfig, 'storageState' | 'headless' | 'startupTimeoutMs'>
  manualLogin?: boolean
  startupTimeoutMs: number
  commandTimeoutMs: number
  provider?: Record<string, unknown>
}

interface SourceSnapshot {
  path: string
  content: string
  sha256: string
}

/** What a model sees: the expectation, the observations and the selected sources. */
export interface RepairBundle {
  task: string
  expectation: Pick<
    DesktopConfig,
    | 'endpoint'
    | 'readySelector'
    | 'readyText'
    | 'busySelector'
    | 'recovery'
    | 'retrySelector'
    | 'timeoutMs'
  >
  observations: DesktopReport
  sources: SourceSnapshot[]
}

interface RepairState {
  schemaVersion: 1
  baseCommit: string
  workspace: string
  phase: string
}

type CommandRecord = CommandResult & { command: string[] }

export interface RepairVerification {
  schemaVersion: 1
  status:
    'verified-candidate' | 'scenario-passed-tests-missing' | 'not-verified'
  scenarioPassed: boolean
  testsPassed: boolean
  error?: string
  baseCommit: string
  summary: string
  limitation: string
}

const exec = promisify(execFile)
const git = async (cwd: string, args: string[]) =>
  (
    await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      maxBuffer: 4000000,
      timeout: 30000,
    })
  ).stdout
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const save = (directory: string, name: string, value: unknown) =>
  writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  })
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Resolve existing ancestor symlinks before creating anything near the source tree.
async function canonicalDestination(path: string) {
  let ancestor = dirname(resolve(path))
  const missing = [basename(path)]
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...missing)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        ancestor === dirname(ancestor)
      )
        throw error
      missing.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
}

// Paths come from a JSON config and from a model's proposal, so they are checked at runtime.
export function validateSourcePath(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !/^[a-zA-Z0-9_@./-]+\.(?:[cm]?[jt]sx?|vue|svelte|html|css|rs)$/.test(
      path,
    ) ||
    path
      .split('/')
      .some((part) => !part || part === '..' || part.startsWith('.')) ||
    /(^|\/)(node_modules|vendor|dist|build|tests?|__tests__|fixtures|coverage)(\/|$)|[.-](test|spec|config)\.|(^|\/)(secrets?|credentials?)[./-]/i.test(
      path,
    )
  ) {
    throw new Error(`Not an allowed application source path: ${String(path)}`)
  }
  return path
}

async function sourceFile(root: string, path: string) {
  validateSourcePath(path)
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink())
      throw new Error('Source symlinks are not allowed')
  }
  const stat = await lstat(current)
  if (!stat.isFile() || stat.size > 100000)
    throw new Error('Each source must be a regular file of at most 100 KB')
  const content = await readFile(current, 'utf8')
  if (content.includes('\0')) throw new Error('Binary source is not allowed')
  return content
}

function loopback(value: string, protocols: string[]) {
  const url = new URL(value)
  if (
    !protocols.includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error(
      'Repair must launch its own local development target at a loopback URL',
    )
  return url
}

export function validateRepairConfig(input: unknown): RepairConfig {
  const raw = input as Record<string, unknown> | null | undefined
  if (!raw || !['web', 'desktop'].includes(raw.target as string))
    throw new Error('target must be web or desktop')
  if (typeof raw.repo !== 'string' || !raw.repo)
    throw new Error('repo is required')
  const sourceFiles = raw.sourceFiles
  if (
    !Array.isArray(sourceFiles) ||
    !sourceFiles.length ||
    sourceFiles.length > 12 ||
    new Set(sourceFiles).size !== sourceFiles.length
  )
    throw new Error(
      'sourceFiles must list 1–12 unique application source paths',
    )
  sourceFiles.forEach(validateSourcePath)
  validateCommand(raw.launch)
  for (const key of ['setup', 'tests']) {
    const commands = raw[key]
    if (commands !== undefined && !Array.isArray(commands))
      throw new Error(`${key} must be an array of commands`)
    ;((commands as unknown[] | undefined) ?? []).forEach(validateCommand)
  }
  const scenario = validateDesktopConfig({
    recovery: 'automatic',
    ...(raw.scenario as DesktopConfig),
  })
  if (raw.target === 'web') loopback(scenario.pageUrl, ['http:', 'https:'])
  else loopback(scenario.cdp as string, ['http:'])
  const config = {
    startupTimeoutMs: 30000,
    commandTimeoutMs: 120000,
    ...raw,
    scenario,
  } as RepairConfig
  if (
    config.manualLogin !== undefined &&
    typeof config.manualLogin !== 'boolean'
  )
    throw new Error('manualLogin must be boolean')
  if (config.manualLogin && config.target !== 'desktop')
    throw new Error(
      'Web repair uses scenario.storageState; manualLogin is for Electron',
    )
  for (const key of ['startupTimeoutMs', 'commandTimeoutMs'] as const)
    if (
      !Number.isInteger(config[key]) ||
      config[key] < 200 ||
      config[key] > 600000
    )
      throw new Error(`${key} must be 200–600000`)
  return config
}

async function portOpen(url: URL) {
  return new Promise<boolean>((resolve) => {
    const socket = netConnect({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

/** Only run the target started in this checkout, not an already-running company app. */
export async function observeRepairTarget(
  config: RepairConfig,
  workspace: string,
  { logPath }: { logPath?: string } = {},
): Promise<DesktopReport> {
  const url = new URL(
    (config.target === 'web'
      ? config.scenario.pageUrl
      : config.scenario.cdp) as string,
  )
  if (await portOpen(url))
    throw new Error(
      'Target port is already in use. Stop that app or choose a dedicated test port; refusing to test a possibly unrelated build',
    )
  if (config.manualLogin && !process.stdin.isTTY)
    throw new Error('manualLogin needs an interactive terminal')
  const app = startCommand(config.launch, workspace, {
    RECOVERY_PROBE_USER_DATA_DIR: join(
      dirname(workspace),
      'electron-test-profile',
    ),
  })
  let browser: Browser | undefined
  try {
    const deadline = Date.now() + config.startupTimeoutMs
    let ready = false
    while (Date.now() < deadline) {
      if (app.result)
        throw new Error(
          'Development launch exited; check your launch command and dependencies',
        )
      if (await portOpen(url)) {
        ready = true
        break
      }
      await delay(100)
    }
    if (!ready)
      throw new Error(
        'Development target did not open its test port before startupTimeoutMs',
      )
    if (config.target === 'web') return await checkWeb(config.scenario)
    if (config.manualLogin) {
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      try {
        await terminal.question(
          'Sign into the launched Electron test app and open the target screen, then press Enter. ',
        )
      } finally {
        terminal.close()
      }
    }
    const attached = await connectDesktop(config.scenario.cdp)
    browser = attached
    let page: Page | undefined
    const pageDeadline = Date.now() + config.startupTimeoutMs
    while (Date.now() < pageDeadline) {
      try {
        page = selectDesktopPage(attached, config.scenario)
        break
      } catch {}
      await delay(100)
    }
    if (!page)
      throw new Error(
        'The launched Electron renderer did not match scenario.pageUrl',
      )
    return await checkDesktop(page, config.scenario)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await app.stop()
    if (logPath) await writeFile(logPath, app.output, { mode: 0o600 })
  }
}

// A proposal comes from a model, so every field is checked before it touches a file.
export function applyProposalToSources(
  proposal: unknown,
  sources: { path: string; content: string }[],
): Map<string, string> {
  const candidate = proposal as Partial<RepairProposal> | null | undefined
  if (
    !candidate ||
    typeof candidate.summary !== 'string' ||
    typeof candidate.reasoning !== 'string' ||
    !Array.isArray(candidate.edits) ||
    candidate.edits.length > 12
  )
    throw new Error('Invalid patch proposal')
  const modified = new Map(
    sources.map((source) => [source.path, source.content]),
  )
  for (const edit of candidate.edits as Partial<RepairEdit>[]) {
    validateSourcePath(edit.path)
    if (
      !modified.has(edit.path as string) ||
      typeof edit.find !== 'string' ||
      !edit.find ||
      typeof edit.replace !== 'string' ||
      edit.replace.length > 100000 ||
      edit.find === edit.replace
    )
      throw new Error('Patch edit must change only an allowlisted source file')
    const path = edit.path as string
    const original = modified.get(path) as string
    const index = original.indexOf(edit.find)
    if (index < 0 || original.indexOf(edit.find, index + 1) !== -1)
      throw new Error(
        'Patch find text must match exactly once; no fuzzy application',
      )
    const result =
      original.slice(0, index) +
      edit.replace +
      original.slice(index + edit.find.length)
    if (Buffer.byteLength(result) > 100000)
      throw new Error('Patched source exceeds the size limit')
    modified.set(path, result)
  }
  return modified
}

async function commands(
  config: RepairConfig,
  workspace: string,
  key: 'setup' | 'tests',
) {
  const results: CommandRecord[] = []
  for (const command of config[key] ?? []) {
    const result = await runCommand(command, workspace, config.commandTimeoutMs)
    results.push({ command, ...result })
    if (result.code !== 0) break
  }
  return results
}

async function assertTrackedUnchanged(workspace: string) {
  if (
    (
      await git(workspace, ['status', '--porcelain', '--untracked-files=no'])
    ).trim()
  )
    throw new Error(
      'Setup, tests or app changed tracked files; refusing unverifiable baseline',
    )
}

export async function prepareRepair(
  input: unknown,
  directory: string,
  { allowExecution = false }: { allowExecution?: boolean } = {},
): Promise<{
  reproduced: boolean
  before: DesktopReport
  bundle: RepairBundle
  state: RepairState
}> {
  if (!allowExecution)
    throw new Error(
      'Configured setup, launch and test commands require --allow-execution',
    )
  const config = validateRepairConfig(input)
  const repo = await realpath(config.repo)
  if (
    (await realpath(
      (await git(repo, ['rev-parse', '--show-toplevel'])).trim(),
    )) !== repo
  )
    throw new Error('repo must be the repository root')
  if (
    (
      await git(repo, ['status', '--porcelain', '--untracked-files=normal'])
    ).trim()
  )
    throw new Error(
      'Commit or stash your changes first; repair starts from a clean committed repository',
    )
  const dir = await canonicalDestination(directory)
  const rel = relative(repo, dir)
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
    throw new Error('Repair output must be outside the source repository')
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 }) // Never overwrite or reuse a run.
  const baseCommit = (await git(repo, ['rev-parse', 'HEAD'])).trim()
  const workspace = join(dir, 'checkout')
  // Check out the committed bytes, whatever this machine's Git converts. Git for Windows
  // writes CRLF by default, and a model's multi-line edit with LF breaks would not match.
  // Explicit eol attributes in .gitattributes still apply.
  await git(dir, [
    'clone',
    '--local',
    '--no-hardlinks',
    '--no-checkout',
    '--config',
    'core.autocrlf=false',
    '--config',
    'core.eol=lf',
    '--',
    repo,
    workspace,
  ])
  await git(workspace, ['checkout', '--detach', baseCommit])
  await git(workspace, ['remote', 'remove', 'origin']) // No accidental push target.
  const sources: SourceSnapshot[] = []
  for (const path of config.sourceFiles) {
    // The index says what a path is. Without symlink rights, Git for Windows checks out
    // a committed symlink as a plain file holding the link text.
    const [mode] = (
      await git(workspace, [
        'ls-files',
        '--stage',
        '--error-unmatch',
        '--',
        path,
      ])
    ).split(' ')
    if (mode === '120000') throw new Error('Source symlinks are not allowed')
    const content = await sourceFile(workspace, path)
    sources.push({ path, content, sha256: sha(content) })
  }
  if (
    sources.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) >
    300000
  )
    throw new Error('Selected sources exceed the 300 KB context limit')
  await save(dir, 'config.json', config)
  await save(dir, 'state.json', {
    schemaVersion: 1,
    baseCommit,
    workspace,
    phase: 'preparing',
  })
  const setup = await commands(config, workspace, 'setup')
  await save(dir, 'setup.json', setup)
  if (setup.some((result) => result.code !== 0))
    throw new Error('Setup failed; see setup.json. No model called')
  const testsBefore = await commands(config, workspace, 'tests')
  await save(dir, 'tests-before.json', testsBefore)
  if (testsBefore.some((result) => result.code !== 0))
    throw new Error(
      'Existing tests already fail; fix the baseline before repair. No model called',
    )
  await assertTrackedUnchanged(workspace)
  const before = await observeRepairTarget(config, workspace, {
    logPath: join(dir, 'launch-before.log'),
  })
  await save(dir, 'before.json', before)
  await assertTrackedUnchanged(workspace)
  const reproduced =
    before.finalReset === 'healthy' &&
    before.results.some((row) => row.outcome === 'fail' && row.applied === 1) &&
    before.results.every((row) => ['pass', 'fail'].includes(row.outcome))
  const state: RepairState = {
    schemaVersion: 1,
    baseCommit,
    workspace,
    phase: reproduced ? 'reproduced' : 'not-reproduced',
  }
  await save(dir, 'state.json', state)
  // Upload bundle intentionally excludes auth state, local paths, command logs and configuration secrets.
  const bundle: RepairBundle = {
    task: 'Repair the reproduced request-recovery defect without weakening its expectation',
    expectation: {
      endpoint: config.scenario.endpoint,
      readySelector: config.scenario.readySelector,
      readyText: config.scenario.readyText,
      busySelector: config.scenario.busySelector,
      recovery: config.scenario.recovery,
      retrySelector: config.scenario.retrySelector,
      timeoutMs: config.scenario.timeoutMs,
    },
    observations: before,
    sources,
  }
  if (reproduced) await save(dir, 'repair-request.json', bundle)
  return { reproduced, before, bundle, state }
}

export async function generateRepair(
  directory: string,
  {
    allowSourceUpload = false,
    apiKey,
    fetchImpl,
  }: {
    allowSourceUpload?: boolean
    apiKey?: string
    fetchImpl?: typeof fetch
  } = {},
): Promise<RepairProposal> {
  const dir = resolve(directory)
  const state: RepairState = JSON.parse(
    await readFile(join(dir, 'state.json'), 'utf8'),
  )
  if (state.phase !== 'reproduced')
    throw new Error('Generate requires a reproduced failure')
  const config: RepairConfig = JSON.parse(
    await readFile(join(dir, 'config.json'), 'utf8'),
  )
  const bundle: RepairBundle = JSON.parse(
    await readFile(join(dir, 'repair-request.json'), 'utf8'),
  )
  const proposal = await proposeRepair(bundle, {
    ...config.provider,
    allowSourceUpload,
    apiKey,
    fetchImpl,
  })
  applyProposalToSources(proposal, bundle.sources)
  await writeFile(
    join(dir, 'proposal.json'),
    JSON.stringify(proposal, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  )
  return proposal
}

export async function verifyRepair(
  directory: string,
  { allowExecution = false }: { allowExecution?: boolean } = {},
): Promise<RepairVerification> {
  if (!allowExecution)
    throw new Error(
      'Review proposal.json first. Verification executes proposed code and requires --allow-execution',
    )
  const dir = await realpath(directory)
  const state: RepairState = JSON.parse(
    await readFile(join(dir, 'state.json'), 'utf8'),
  )
  if (state.phase !== 'reproduced')
    throw new Error(
      'This run is not available for verification; start a new run',
    )
  const workspace = await realpath(join(dir, 'checkout'))
  if (state.workspace !== workspace)
    throw new Error('Checkout identity changed')
  if ((await git(workspace, ['rev-parse', 'HEAD'])).trim() !== state.baseCommit)
    throw new Error('Checkout commit changed')
  await assertTrackedUnchanged(workspace)
  const config = validateRepairConfig(
    JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')),
  )
  const bundle: RepairBundle = JSON.parse(
    await readFile(join(dir, 'repair-request.json'), 'utf8'),
  )
  const proposal: RepairProposal = JSON.parse(
    await readFile(join(dir, 'proposal.json'), 'utf8'),
  )
  if (!proposal.edits?.length)
    throw new Error('No patch proposed; inspect the explanation')
  for (const file of bundle.sources) {
    if (
      !config.sourceFiles.includes(file.path) ||
      sha(file.content) !== file.sha256 ||
      sha(await sourceFile(workspace, file.path)) !== file.sha256
    )
      throw new Error('Source snapshot changed; start a new run')
  }
  const modified = applyProposalToSources(proposal, bundle.sources)
  for (const [path, content] of modified)
    await writeFile(join(workspace, path), content)
  const patch = await git(workspace, ['diff', '--no-ext-diff', '--binary'])
  if (!patch.trim()) throw new Error('Proposal has no net source changes')
  await writeFile(join(dir, 'candidate.patch'), patch, {
    mode: 0o600,
    flag: 'wx',
  })
  await save(dir, 'state.json', { ...state, phase: 'verifying' })
  let after: DesktopReport | undefined
  let testsAfter: CommandRecord[] = []
  let error: string | undefined
  try {
    after = await observeRepairTarget(config, workspace, {
      logPath: join(dir, 'launch-after.log'),
    })
    await save(dir, 'after.json', after)
    testsAfter = await commands(config, workspace, 'tests')
    await save(dir, 'tests-after.json', testsAfter)
    if ((await git(workspace, ['diff', '--no-ext-diff', '--binary'])) !== patch)
      throw new Error(
        'App or test command changed the candidate patch during verification',
      )
  } catch (value) {
    error = (value as Error).message
  }
  const scenarioPassed = !error && after?.ok === true
  const testsPassed =
    testsAfter.length > 0 &&
    testsAfter.length === config.tests?.length &&
    testsAfter.every((result) => result.code === 0)
  const result: RepairVerification = {
    schemaVersion: 1,
    status:
      scenarioPassed && testsPassed
        ? 'verified-candidate'
        : scenarioPassed && !config.tests?.length
          ? 'scenario-passed-tests-missing'
          : 'not-verified',
    scenarioPassed,
    testsPassed,
    error,
    baseCommit: state.baseCommit,
    summary: proposal.summary,
    limitation:
      'A candidate only: the configured scenario and supplied test commands are bounded evidence, not proof of general correctness. Review candidate.patch. Nothing was applied to the original repository, committed, pushed or deployed.',
  }
  await save(dir, 'verification.json', result)
  await save(dir, 'state.json', { ...state, phase: result.status })
  return result
}
