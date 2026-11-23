import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  executionEnvironment,
  runCommand,
  type CommandResult,
} from '../process.mjs'
import { trackedFilesChanged } from './checkout.mjs'
import { projectCriteria, sha256, type Sides } from './criteria.mjs'
import { blobAt } from './git.mjs'
import { shownIn } from './plan-claims.mjs'
import type { ProjectCheck } from './policy.mjs'
import {
  changeOf,
  criteriaChangeOf,
  projectStatement,
  type PolicyContext,
} from './policy-claims.mjs'
import { decideClaim, type ExecutionStatus } from './rules.mjs'
import { stopIfAborted } from './side.mjs'
import type { Claim } from './types.mjs'

export type Side = 'base' | 'candidate'

export interface ProjectAttempt {
  n: number
  result: CommandResult
  durationMs: number
  /** The full log, every byte the command printed. */
  log: string
}

export interface ProjectSide {
  status: ExecutionStatus
  attempts: ProjectAttempt[]
  /** A command changed tracked files; they were put back before the next one. */
  modifiedTracked: boolean
  gap?: string
}

/** The variables the policy names, with the values verify itself was given. */
export const policyEnv = (names: string[]) =>
  Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]!]],
    ),
  )

const tail = (output: string) => output.trim().split('\n').slice(-3).join(' / ')

/** Runs the policy's setup in `side`'s checkout; why it failed, if it did. */
async function runSetup(context: PolicyContext, side: Side) {
  const { policy, budget, directory } = context
  const checkout = (await context.checkouts())[side]
  const folder = join(directory, 'policy', side)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  for (const [i, command] of policy.setup.entries()) {
    const result = await runCommand(
      command,
      checkout,
      Math.max(1000, budget.workLeftMs()),
      { env: policyEnv(policy.env), log: join(folder, `setup-${i + 1}.log`) },
    )
    if (result.code !== 0)
      return `${command.join(' ')} ${result.timedOut ? 'timed out' : `exited with ${result.code}`}: ${tail(result.output)}`
    if (await trackedFilesChanged(checkout))
      return `${command.join(' ')} changed tracked files`
  }
  return undefined
}

/** The policy's setup, run once per side before the first command or launch there. */
export function setupOnce(context: PolicyContext, side: Side) {
  let setup = context.setups.get(side)
  if (!setup) {
    setup = runSetup(context, side)
    context.setups.set(side, setup)
  }
  return setup
}

const statusOf = (attempts: ProjectAttempt[]): ExecutionStatus => {
  const stopped = attempts.find(({ result }) => result.timedOut || result.error)
  if (!stopped) return 'completed'
  return stopped.result.timedOut ? 'timed-out' : 'failed-to-start'
}

/** One attempt of a project check, with its full log, recorded as it ends. */
async function attemptIn(
  context: PolicyContext,
  check: ProjectCheck,
  where: { checkout: string; folder: string; side: Side },
  n: number,
): Promise<ProjectAttempt> {
  const file = join(where.folder, `attempt-${n}.log`)
  const started = performance.now()
  const result = await runCommand(
    check.command,
    where.checkout,
    check.timeoutMs,
    {
      env: policyEnv(context.policy.env),
      log: file,
    },
  )
  await context.log.attempt(`project/${check.id}`, {
    side: where.side,
    n,
    exitCode: result.code,
    ...(result.timedOut ? { stopped: 'timed-out' as const } : {}),
    log: shownIn(context.directory, file),
  })
  return {
    n,
    result,
    durationMs: Math.round(performance.now() - started),
    log: file,
  }
}

/** Runs a project check `attempts` times in `side`'s checkout, each under its own timeout. */
export async function runProjectSide(
  context: PolicyContext,
  check: ProjectCheck,
  side: Side,
): Promise<ProjectSide> {
  const { budget, directory, options } = context
  const failure = await setupOnce(context, side)
  if (failure)
    return {
      status: 'failed-to-start',
      attempts: [],
      modifiedTracked: false,
      gap: `SETUP_FAILED: ${failure}`,
    }
  const checkout = (await context.checkouts())[side]
  const folder = join(directory, 'policy', side, 'project', check.id)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const attempts: ProjectAttempt[] = []
  let modifiedTracked = false
  for (let n = 1; n <= check.attempts; n++) {
    stopIfAborted('after', options.signal)
    if (!budget.fits(check.timeoutMs))
      return {
        status: 'budget-exhausted',
        attempts,
        modifiedTracked,
        gap: 'BUDGET_EXHAUSTED: the rest of the attempts would not fit in the budget',
      }
    const attempt = await attemptIn(
      context,
      check,
      { checkout, folder, side },
      n,
    )
    attempts.push(attempt)
    modifiedTracked = (await trackedFilesChanged(checkout)) || modifiedTracked
  }
  return { status: statusOf(attempts), attempts, modifiedTracked }
}

const passed = (side: ProjectSide) =>
  side.status === 'completed' && side.attempts.every((a) => a.result.code === 0)

/** Section 6's table: a command-level comparison of the two sides. */
export function compareProject(base: ProjectSide, candidate: ProjectSide) {
  if (candidate.status !== 'completed' || base.status !== 'completed')
    return 'NOT_COMPARABLE'
  if (passed(base)) return passed(candidate) ? 'STILL_PASSING' : 'NEW_FAILURE'
  return passed(candidate) ? 'RESOLVED_FAILURE' : 'FAILING_ON_BOTH'
}

/** Each attempt's full log, relative to the run folder, with its hash. */
const logFiles = async (directory: string, attempts: ProjectAttempt[]) =>
  Promise.all(
    attempts.map(async ({ log }) => ({
      path: shownIn(directory, log),
      sha256: sha256(await readFile(log)),
    })),
  )

const COMMAND_LEVEL =
  'COMMAND_LEVEL: only the exit code counts; no per-test results were collected, so a new failure can hide among existing ones'

const sideGaps = (base: ProjectSide, candidate: ProjectSide) => [
  ...(candidate.modifiedTracked
    ? ['CHECK_MODIFIED_TRACKED_FILES: the command changed tracked files']
    : []),
  ...(candidate.gap ? [candidate.gap] : []),
  ...(base.gap ? [`BASE: ${base.gap}`] : []),
  ...(base.status === 'completed' ? [] : [`BASE: ${base.status}`]),
  ...(base.modifiedTracked
    ? ['BASE: CHECK_MODIFIED_TRACKED_FILES: the command changed tracked files']
    : []),
]

/**
 * A project check, run with the approved command on both sides. It's judged by section 6's
 * table, even when the candidate changed its inputs, so the result against the approved
 * version still shows.
 */
export async function projectClaim(
  context: PolicyContext,
  check: ProjectCheck,
): Promise<Claim> {
  const id = `project/${check.id}`
  const criteria = await projectCriteria(context.sides, check)
  const base = await runProjectSide(context, check, 'base')
  const candidate = await runProjectSide(context, check, 'candidate')
  const comparison = compareProject(base, candidate)
  const change = changeOf(context, criteria.change)
  return {
    id,
    kind: 'project-check',
    statement: projectStatement(check),
    expectation: criteria.expectation,
    ...decideClaim({
      expectation: change,
      // The command reads its inputs from each side's checkout, so a changed input ran.
      approvedCriteriaRan: criteria.change === 'present',
      attempts: candidate.attempts.map(({ result }) => {
        const completed = !result.timedOut && !result.error
        return { completed, failed: completed && result.code !== 0 }
      }),
      execution: candidate.status,
      incomplete: candidate.modifiedTracked
        ? ['CHECK_MODIFIED_TRACKED_FILES']
        : [],
      failure: ['NEW_FAILURE', 'FAILING_ON_BOTH'].includes(comparison)
        ? comparison
        : 'NOT_COMPARABLE',
    }),
    ...criteriaChangeOf(change),
    execution: {
      status: candidate.status,
      attempts: context.log.attemptsOf(id),
    },
    baseline: { status: base.status, comparison },
    evidence: await logFiles(context.directory, [
      ...base.attempts,
      ...candidate.attempts,
    ]),
    gaps: [...sideGaps(base, candidate), COMMAND_LEVEL],
  }
}

const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]

/** The fingerprint commands ran with, and each side's lockfiles: a difference is part of the change. */
export async function environmentOf(sides: Sides, names: string[]) {
  const lockfiles = { base: {}, candidate: {} } as Record<
    Side,
    Record<string, string>
  >
  for (const side of ['base', 'candidate'] as const)
    for (const path of LOCKFILES) {
      const bytes = await blobAt(sides.root, sides[side], path)
      if (bytes) lockfiles[side][path] = sha256(bytes)
    }
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    envNames: [
      ...Object.keys(executionEnvironment()),
      ...Object.keys(policyEnv(names)),
    ].sort(),
    lockfiles,
  }
}
