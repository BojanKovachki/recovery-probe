import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ensure } from '../../core/validate.mjs'
import type { DesktopConfig } from '../../workflows/check/http/config.mjs'
import type { DesktopReport } from '../../workflows/check/http/run.mjs'
import { validateRepairConfig, type RepairConfig } from './config.mjs'
import { proposeRepair, type RepairProposal } from './provider.mjs'
import {
  applyProposalToSources,
  snapshotSources,
  sourceFile,
  type SourceSnapshot,
} from './sources.mjs'
import { observeRepairTarget } from './target.mjs'
import {
  assertTrackedUnchanged,
  git,
  prepareWorkspace,
  runCommands,
  save,
  sha,
  type CommandRecord,
} from './workspace.mjs'

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

const readJson = async <T,>(dir: string, name: string): Promise<T> =>
  JSON.parse(await readFile(join(dir, name), 'utf8'))

/** Reproduces the failure in a clean checkout of the repository; no model is called. */
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
  ensure(
    allowExecution,
    'Configured setup, launch and test commands require --allow-execution',
  )
  const config = validateRepairConfig(input)
  const { dir, baseCommit, workspace } = await prepareWorkspace(
    config.repo,
    directory,
  )
  const sources = await snapshotSources(workspace, config.sourceFiles)
  await save(dir, 'config.json', config)
  await save(dir, 'state.json', {
    schemaVersion: 1,
    baseCommit,
    workspace,
    phase: 'preparing',
  })
  await runBaseline(config, workspace, dir)
  const before = await observeRepairTarget(config, workspace, {
    logPath: join(dir, 'launch-before.log'),
  })
  await save(dir, 'before.json', before)
  await assertTrackedUnchanged(workspace)
  const reproduced = isReproduced(before)
  const state: RepairState = {
    schemaVersion: 1,
    baseCommit,
    workspace,
    phase: reproduced ? 'reproduced' : 'not-reproduced',
  }
  await save(dir, 'state.json', state)
  const bundle = repairBundle(config, before, sources)
  if (reproduced) await save(dir, 'repair-request.json', bundle)
  return { reproduced, before, bundle, state }
}

/** The setup, then the existing tests: both must pass before a model is involved. */
async function runBaseline(
  config: RepairConfig,
  workspace: string,
  dir: string,
) {
  const setup = await runCommands(config, workspace, 'setup')
  await save(dir, 'setup.json', setup)
  ensure(
    setup.every((result) => result.code === 0),
    'Setup failed; see setup.json. No model called',
  )
  const testsBefore = await runCommands(config, workspace, 'tests')
  await save(dir, 'tests-before.json', testsBefore)
  ensure(
    testsBefore.every((result) => result.code === 0),
    'Existing tests already fail; fix the baseline before repair. No model called',
  )
  await assertTrackedUnchanged(workspace)
}

const isReproduced = (before: DesktopReport) =>
  before.finalReset === 'healthy' &&
  before.results.some((row) => row.outcome === 'fail' && row.applied === 1) &&
  before.results.every((row) => ['pass', 'fail'].includes(row.outcome))

// Upload bundle intentionally excludes auth state, local paths, command logs and configuration secrets.
const repairBundle = (
  config: RepairConfig,
  before: DesktopReport,
  sources: SourceSnapshot[],
): RepairBundle => ({
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
})

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
  const state = await readJson<RepairState>(dir, 'state.json')
  ensure(state.phase === 'reproduced', 'Generate requires a reproduced failure')
  const config = await readJson<RepairConfig>(dir, 'config.json')
  const bundle = await readJson<RepairBundle>(dir, 'repair-request.json')
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

interface OpenRun {
  dir: string
  state: RepairState
  workspace: string
  config: RepairConfig
  bundle: RepairBundle
  proposal: RepairProposal
}

interface CandidateRun {
  after?: DesktopReport
  testsAfter: CommandRecord[]
  error?: string
}

/** Applies the proposal to a reproduced run's checkout and runs the scenario and tests. */
export async function verifyRepair(
  directory: string,
  { allowExecution = false }: { allowExecution?: boolean } = {},
): Promise<RepairVerification> {
  ensure(
    allowExecution,
    'Review proposal.json first. Verification executes proposed code and requires --allow-execution',
  )
  const run = await openRun(directory)
  const patch = await writeCandidate(run)
  const result = verdict(run, await runCandidate(run, patch))
  await save(run.dir, 'verification.json', result)
  await save(run.dir, 'state.json', { ...run.state, phase: result.status })
  return result
}

/** A reproduced run's folder, checked for changes since it was prepared. */
async function openRun(directory: string): Promise<OpenRun> {
  const dir = await realpath(directory)
  const state = await readJson<RepairState>(dir, 'state.json')
  ensure(
    state.phase === 'reproduced',
    'This run is not available for verification; start a new run',
  )
  const workspace = await realpath(join(dir, 'checkout'))
  ensure(state.workspace === workspace, 'Checkout identity changed')
  ensure(
    (await git(workspace, ['rev-parse', 'HEAD'])).trim() === state.baseCommit,
    'Checkout commit changed',
  )
  await assertTrackedUnchanged(workspace)
  const config = validateRepairConfig(await readJson(dir, 'config.json'))
  const bundle = await readJson<RepairBundle>(dir, 'repair-request.json')
  const proposal = await readJson<RepairProposal>(dir, 'proposal.json')
  ensure(proposal.edits?.length, 'No patch proposed; inspect the explanation')
  return { dir, state, workspace, config, bundle, proposal }
}

/** Applies the proposal to unchanged sources and records it as candidate.patch. */
async function writeCandidate({
  dir,
  state,
  workspace,
  config,
  bundle,
  proposal,
}: OpenRun) {
  for (const file of bundle.sources)
    ensure(
      config.sourceFiles.includes(file.path) &&
        sha(file.content) === file.sha256 &&
        sha(await sourceFile(workspace, file.path)) === file.sha256,
      'Source snapshot changed; start a new run',
    )
  const modified = applyProposalToSources(proposal, bundle.sources)
  for (const [path, content] of modified)
    await writeFile(join(workspace, path), content)
  const patch = await git(workspace, ['diff', '--no-ext-diff', '--binary'])
  ensure(patch.trim(), 'Proposal has no net source changes')
  await writeFile(join(dir, 'candidate.patch'), patch, {
    mode: 0o600,
    flag: 'wx',
  })
  await save(dir, 'state.json', { ...state, phase: 'verifying' })
  return patch
}

/** Runs the scenario and the tests on the candidate; an error is recorded, not thrown. */
async function runCandidate(
  { dir, workspace, config }: OpenRun,
  patch: string,
): Promise<CandidateRun> {
  const run: CandidateRun = { testsAfter: [] }
  try {
    run.after = await observeRepairTarget(config, workspace, {
      logPath: join(dir, 'launch-after.log'),
    })
    await save(dir, 'after.json', run.after)
    run.testsAfter = await runCommands(config, workspace, 'tests')
    await save(dir, 'tests-after.json', run.testsAfter)
    ensure(
      (await git(workspace, ['diff', '--no-ext-diff', '--binary'])) === patch,
      'App or test command changed the candidate patch during verification',
    )
  } catch (value) {
    run.error = (value as Error).message
  }
  return run
}

function verdict(
  { state, config, proposal }: OpenRun,
  { after, testsAfter, error }: CandidateRun,
): RepairVerification {
  const scenarioPassed = !error && after?.ok === true
  const testsPassed =
    testsAfter.length > 0 &&
    testsAfter.length === config.tests?.length &&
    testsAfter.every((result) => result.code === 0)
  return {
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
}
