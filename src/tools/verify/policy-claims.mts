import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunBudget } from '../../core/budget.mjs'
import type { CheckResult, CheckRunner } from '../watch/checks.mjs'
import {
  compareSides,
  runAgainstRunningApp,
  runOnSide,
  type SideResult,
} from './app-sides.mjs'
import type { Checkouts } from './checkout.mjs'
import {
  behaviorCriteria,
  copyApproved,
  type BehaviorCriteria,
  type Registries,
  type Sides,
} from './criteria.mjs'
import { codeOf, evidenceFiles } from './plan-claims.mjs'
import type { Policy, PolicyClaim, ProjectCheck } from './policy.mjs'
import type { VerificationLog } from './record.mjs'
import { decideClaim, type ClaimFacts } from './rules.mjs'
import type { VerifyEvent } from './side.mjs'
import type { TestChanges } from './changed-files.mjs'
import type { Claim, PolicyIdentity } from './types.mjs'

export interface PolicyOptions {
  /** The policy file as the working tree names it; its committed copy on the base is the one used. */
  policy: string
  /** The base, from the invocation: never from a file the candidate can edit. */
  base: string
  /** Lowers the policy's overall budget; it can never raise it. */
  budgetMs?: number
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
  budget: RunBudget
  /** The base and candidate checkouts, made the first time a claim needs them. */
  checkouts(): Promise<Checkouts>
  /** Each side's setup, run once before its first command or launch: why it failed, if it did. */
  setups: Map<'base' | 'candidate', Promise<string | undefined>>
  /** What the candidate did to the base's test files. */
  tests: TestChanges
}

const GAP_TEXT: Record<string, string> = {
  APP_REVISION_UNKNOWN:
    'the scenarios ran against an app started by hand, so which code it ran is unknown',
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
export const changeOf = (
  context: PolicyContext,
  change: ClaimFacts['expectation'],
): ClaimFacts['expectation'] =>
  context.identity.changedInCandidate ? 'POLICY_CHANGED' : change

/** The candidate's change to a claim's criteria, kept whatever the outcome: a person must approve it. */
export const criteriaChangeOf = (change: ClaimFacts['expectation']) =>
  change === 'present' || change === 'missing' ? {} : { criteriaChange: change }

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

interface ClaimRuns {
  candidate: SideResult
  /** Only a claim whose app the policy launches runs on the base. */
  base?: SideResult
}

/** Both sides on their own launches of the app, or the candidate on an app started by hand. */
async function runClaim(
  context: PolicyContext,
  claim: PolicyClaim,
  scenarios: NonNullable<BehaviorCriteria['scenarios']>,
): Promise<ClaimRuns> {
  if (!claim.app)
    return { candidate: await runAgainstRunningApp(context, claim, scenarios) }
  const base = await runOnSide(context, claim, scenarios, 'base')
  return {
    base,
    candidate: await runOnSide(context, claim, scenarios, 'candidate'),
  }
}

const sideGaps = (claim: PolicyClaim, runs: ClaimRuns | undefined) => [
  ...(runs?.base?.gap ? [`BASE: ${runs.base.gap}`] : []),
  ...(runs?.candidate.gap ? [runs.candidate.gap] : []),
  ...(runs && !claim.app
    ? ['BASE_NOT_RUN: only an app the policy launches runs on the base']
    : []),
]

/** How the base side went and what its comparison with the candidate says, if it ran. */
function baselineOf(runs: ClaimRuns | undefined) {
  if (!runs?.base)
    return { failure: 'NOT_COMPARABLE', baseline: { status: 'unavailable' } }
  const { failure, verdict } = compareSides(runs.base, runs.candidate)
  return {
    failure,
    baseline: {
      status: runs.base.status,
      ...(verdict ? { comparison: verdict } : {}),
    },
  }
}

/** The facts the rules decide a behavior claim from, after its scenarios ran on each side. */
async function behaviorFacts(claim: PolicyClaim, runs: ClaimRuns | undefined) {
  const candidate = runs?.candidate.runs ?? []
  const results = candidate.map((run) => run.result)
  const checked = await Promise.all(
    results.map((run) => assertionsIn(run, claim.assertions)),
  )
  const partial = results.find((run) => run.evidence && !run.evidence.complete)
  const incomplete = runs
    ? [
        ...(partial ? [codeOf(partial.evidence!.gaps)] : []),
        ...(checked.some((run) => run.missing) ? ['ASSERTION_NOT_RUN'] : []),
        ...(claim.app ? [] : ['APP_REVISION_UNKNOWN']),
      ]
    : []
  const { failure, baseline } = baselineOf(runs)
  const facts: Omit<ClaimFacts, 'expectation'> = {
    attempts: results.map((run, i) => ({
      completed: run.evidence?.complete === true,
      failed: sawDefect(run) || checked[i].unmet,
      scenario: candidate[i].path,
    })),
    execution: runs ? runs.candidate.status : 'skipped',
    incomplete,
    failure,
  }
  return {
    facts,
    baseline,
    gaps: [...incomplete.map(gapText), ...sideGaps(claim, runs)],
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
  await copyApproved(
    sides,
    criteria.files,
    join(directory, 'policy', 'approved'),
  )
  const runs = criteria.scenarios
    ? await runClaim(context, claim, criteria.scenarios)
    : undefined
  const { facts, baseline, gaps } = await behaviorFacts(claim, runs)
  const results = [...(runs?.base?.runs ?? []), ...(runs?.candidate.runs ?? [])]
  const change = changeOf(context, criteria.change)
  return {
    id,
    kind: 'behavior',
    statement: behaviorStatement(claim, registries),
    expectation: criteria.expectation,
    ...decideClaim({
      ...facts,
      expectation: change,
      // Both sides run the base's registry entry with copies of the base's files.
      approvedCriteriaRan: true,
    }),
    ...criteriaChangeOf(change),
    execution: {
      status: facts.execution,
      attempts: context.log.attemptsOf(id),
    },
    baseline,
    evidence: await evidenceFiles(
      directory,
      results.map((run) => run.result),
    ),
    gaps: [
      ...(criteria.missing ? [`EXPECTATION_MISSING: ${criteria.missing}`] : []),
      ...gaps,
    ],
  }
}
