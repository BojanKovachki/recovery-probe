import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runCheck,
  runRecoveryProbe,
  type CheckResult,
  type CheckRunner,
} from '../watch/checks.mjs'
import {
  behaviorCriteria,
  copyApproved,
  projectCriteria,
  withApprovedFiles,
  type BehaviorCriteria,
  type Registries,
  type Sides,
} from './criteria.mjs'
import {
  attemptOf,
  codeOf,
  evidenceFiles,
  executionOf,
} from './plan-claims.mjs'
import type { Policy, PolicyClaim, ProjectCheck } from './policy.mjs'
import type { VerificationLog } from './record.mjs'
import { decideClaim, type ClaimFacts } from './rules.mjs'
import { stopIfAborted, type VerifyEvent } from './side.mjs'
import type { Claim, PolicyIdentity } from './types.mjs'

export interface PolicyOptions {
  /** The policy file as the working tree names it; its committed copy on the base is the one used. */
  policy: string
  /** The base, from the invocation: never from a file the candidate can edit. */
  base: string
  /** Where the runs are kept; .recovery-probe/verify by default. */
  directory?: string
  runCommand?: CheckRunner
  onEvent?: (event: VerifyEvent) => void
  signal?: AbortSignal
}

/** What deciding a policy's claims needs. */
export interface PolicyContext {
  options: PolicyOptions
  sides: Sides
  directory: string
  log: VerificationLog
  registries: Registries
  policy: Policy
  identity: PolicyIdentity
}

const GAP_TEXT: Record<string, string> = {
  APP_REVISION_UNKNOWN:
    'the scenarios ran against an app started by hand, so which code it ran is unknown',
  APP_LAUNCH_UNAVAILABLE:
    "launching the claim's app from each side's checkout comes in a later version",
  ASSERTION_NOT_RUN: 'a report has no expect step for a named assertion',
}
const gapText = (code: string) =>
  GAP_TEXT[code] ? `${code}: ${GAP_TEXT[code]}` : code

export const projectStatement = (check: ProjectCheck) =>
  `${check.command.join(' ')} passes`

/** What a claim says: its failure scenario's approved expectation, else its behavior. */
export const behaviorStatement = (
  claim: PolicyClaim,
  registries: Registries,
) => {
  const entry = registries.base.get(claim.failurePath)
  return String(entry?.expectation ?? entry?.behavior ?? `claim ${claim.id}`)
}

/** A candidate change to the policy outranks one to a single claim's criteria. */
const changeOf = (
  context: PolicyContext,
  change: ClaimFacts['expectation'],
): ClaimFacts['expectation'] =>
  context.identity.changedInCandidate ? 'POLICY_CHANGED' : change

/** Project checks are judged and listed, but they run in disposable checkouts in a later version. */
export async function projectClaim(
  context: PolicyContext,
  check: ProjectCheck,
): Promise<Claim> {
  const criteria = await projectCriteria(context.sides, check)
  return {
    id: `project/${check.id}`,
    kind: 'project-check',
    statement: projectStatement(check),
    expectation: criteria.expectation,
    ...decideClaim({
      expectation: changeOf(context, criteria.change),
      attempts: [],
      execution: 'unavailable',
      incomplete: [],
      failure: 'NOT_COMPARABLE',
    }),
    execution: { status: 'unavailable', attempts: [] },
    baseline: { status: 'unavailable' },
    evidence: [],
    gaps: [
      'PROJECT_CHECKS_UNAVAILABLE: approved project checks run in disposable checkouts in a later version',
    ],
  }
}

/** Runs both scenarios `runs` times with the base's approved files, against the running app. */
async function runScenarios(
  context: PolicyContext,
  claim: PolicyClaim,
  scenarios: NonNullable<BehaviorCriteria['scenarios']>,
) {
  const { sides, directory, log, options, policy } = context
  const folder = join(directory, 'policy', 'candidate', claim.id)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const results: CheckResult[] = []
  for (const path of ['failure', 'normal'] as const) {
    const approved = join(directory, 'policy', 'approved')
    const command = withApprovedFiles(sides, scenarios[path], approved)
    for (let n = 1; n <= policy.runs; n++) {
      stopIfAborted('after', options.signal)
      const check = `${claim.id} ${path}`
      options.onEvent?.({ type: 'running', side: 'after', check, run: n })
      const out = join(folder, `${path}-${n}`)
      const result = await runCheck(
        command,
        out,
        options.runCommand ?? runRecoveryProbe,
        { signal: options.signal },
      )
      await writeFile(`${out}.log`, result.output, { mode: 0o600 })
      options.onEvent?.({ type: 'ran', side: 'after', check, result })
      await log.attempt(`behavior/${claim.id}`, {
        ...attemptOf(directory, result, n, out),
        path,
        against: 'approvedVersion',
      })
      results.push(result)
    }
  }
  return results
}

/** Whether a run's report has each named `expect` step, and whether one was unmet. */
async function assertionsIn(run: CheckResult, names: string[]) {
  let steps: { kind?: string; name?: string; status?: string }[] = []
  if (names.length && run.report)
    steps = await readFile(run.report, 'utf8')
      .then((text) => JSON.parse(text)?.operator?.steps ?? [])
      .catch(() => [])
  const statusOf = (name: string) =>
    steps.find((step) => step?.kind === 'expect' && step.name === name)?.status
  return {
    unmet: names.some((name) => statusOf(name) === 'unmet'),
    missing: names.some((name) => statusOf(name) === undefined),
  }
}

/** A policy path fails on a suspected defect; a lead is for review, not a failure. */
const sawDefect = (run: CheckResult) =>
  run.evidence?.problems.some((problem) => problem.severity === 'defect') ??
  false

/** The facts the rules decide a behavior claim from, after its scenarios ran. */
async function behaviorFacts(
  claim: PolicyClaim,
  criteria: BehaviorCriteria,
  results: CheckResult[],
): Promise<Omit<ClaimFacts, 'expectation' | 'failure'>> {
  const checked = await Promise.all(
    results.map((run) => assertionsIn(run, claim.assertions)),
  )
  const partial = results.find((run) => run.evidence && !run.evidence.complete)
  const incomplete = criteria.scenarios
    ? [
        ...(partial ? [codeOf(partial.evidence!.gaps[0])] : []),
        ...(checked.some((run) => run.missing) ? ['ASSERTION_NOT_RUN'] : []),
        claim.app ? 'APP_LAUNCH_UNAVAILABLE' : 'APP_REVISION_UNKNOWN',
      ]
    : []
  return {
    attempts: results.map((run, i) => ({
      completed: run.evidence?.complete === true,
      failed: sawDefect(run) || checked[i].unmet,
    })),
    execution: !criteria.scenarios
      ? 'skipped'
      : claim.app
        ? 'unavailable'
        : executionOf(results),
    incomplete,
  }
}

/**
 * A behavior claim, judged by the base's criteria. Its scenarios run with the approved files,
 * even when the candidate changed them, so the result against the approved version still shows.
 */
export async function behaviorClaim(
  context: PolicyContext,
  claim: PolicyClaim,
): Promise<Claim> {
  const id = `behavior/${claim.id}`
  const { sides, directory, registries } = context
  const criteria = await behaviorCriteria(sides, claim, registries)
  const { scenarios } = criteria
  await copyApproved(
    sides,
    criteria.files,
    join(directory, 'policy', 'approved'),
  )
  const results =
    scenarios && !claim.app ? await runScenarios(context, claim, scenarios) : []
  const facts = await behaviorFacts(claim, criteria, results)
  return {
    id,
    kind: 'behavior',
    statement: behaviorStatement(claim, registries),
    expectation: criteria.expectation,
    ...decideClaim({
      ...facts,
      expectation: changeOf(context, criteria.change),
      failure: 'NOT_COMPARABLE',
    }),
    execution: {
      status: facts.execution,
      attempts: context.log.attemptsOf(id),
    },
    baseline: { status: 'unavailable' },
    evidence: await evidenceFiles(directory, results),
    gaps: [
      ...(criteria.missing ? [`EXPECTATION_MISSING: ${criteria.missing}`] : []),
      ...facts.incomplete.map(gapText),
      'BASE_NOT_RUN: the base side runs once apps are launched from each checkout',
    ],
  }
}
