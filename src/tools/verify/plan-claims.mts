import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Comparison } from '../compare/types.mjs'
import type { Suspect } from '../suspects/source.mjs'
import type { VerifyCheck, VerifyPlan } from '../verify-plan.mjs'
import type { CheckResult } from '../watch/checks.mjs'
import type { PendingClaim } from './record.mjs'
import { decideClaim, type ExecutionStatus } from './rules.mjs'
import type { Claim, ClaimAttempt, Expectation } from './types.mjs'

/** A plan's checks are the criteria, and nobody approves a plan file. */
export const PLAN_EXPECTATION: Expectation = { source: 'plan', approved: false }

export const SUSPECTS_CLAIM = 'suspects/changed-lines'
export const checkClaim = (check: VerifyCheck) => `behavior/${check.name}`
const planStatement = (check: VerifyCheck) =>
  `${check.command.join(' ')} improves or stays clean after the change`
const suspectStatement = (base: string) =>
  `No line changed since ${base} matches a known data-loss pattern`

/** The claims a plan's verification will decide, before any result. */
export const pendingPlanClaims = (plan: VerifyPlan): PendingClaim[] => [
  ...plan.checks.map((check) => ({
    id: checkClaim(check),
    kind: 'behavior' as const,
    statement: planStatement(check),
    expectation: PLAN_EXPECTATION,
  })),
  pendingSuspectClaim(plan.base, PLAN_EXPECTATION),
]

export const pendingSuspectClaim = (
  base: string,
  expectation: Expectation,
): PendingClaim => ({
  id: SUSPECTS_CLAIM,
  kind: 'suspect-scan',
  statement: suspectStatement(base),
  expectation,
})

/** `path` relative to the run folder, with forward slashes. */
export const shownIn = (directory: string, path: string) =>
  relative(directory, path).split(sep).join('/')

/** A run saw a failure when its report records any problem, as verify has always judged. */
export const sawFailure = (run: CheckResult) =>
  (run.evidence?.problems.length ?? 0) > 0

/** Completed when every run wrote a report; otherwise what kept the first one from it. */
export const executionOf = (runs: CheckResult[]): ExecutionStatus =>
  runs.find((run) => !run.evidence)?.stopped ??
  (runs.every((run) => run.evidence) ? 'completed' : 'failed-to-start')

const UNCOMPARABLE = ['NOT_COMPARABLE', 'INCONCLUSIVE']

/** The first code among a run's gaps, such as FAULT_NOT_TRIGGERED; some gaps are plain notes. */
export const codeOf = (gaps: string[]) =>
  gaps.map((gap) => /^[A-Z][A-Z0-9_]+/.exec(gap)?.[0]).find(Boolean) ??
  'INCOMPLETE_RUN'

function incompleteOf(
  runs: CheckResult[],
  comparison: Comparison | undefined,
  baselinePresent: boolean,
) {
  const codes = baselinePresent ? [] : ['NO_BASELINE']
  const partial = runs.find((run) => run.evidence && !run.evidence.complete)
  if (partial) codes.push(codeOf(partial.evidence!.gaps))
  if (comparison && UNCOMPARABLE.includes(comparison.verdict))
    codes.push(comparison.verdict)
  return codes
}

const failureOf = (comparison: Comparison | undefined) =>
  !comparison || UNCOMPARABLE.includes(comparison.verdict)
    ? 'NOT_COMPARABLE'
    : comparison.exitCode === 1
      ? 'NEW_FAILURE'
      : 'FAILING_ON_BOTH'

/** The report files `runs` wrote, relative to `directory`, with their hashes. */
export async function evidenceFiles(directory: string, runs: CheckResult[]) {
  const files = []
  for (const run of runs)
    if (run.report)
      files.push({
        path: shownIn(directory, run.report),
        sha256: createHash('sha256')
          .update(await readFile(run.report))
          .digest('hex'),
      })
  return files
}

/** The run's attempt; its log sits next to its folder. */
export const attemptOf = (
  directory: string,
  run: CheckResult,
  n: number,
  folder: string,
): ClaimAttempt => ({
  side: 'candidate',
  n,
  exitCode: run.exitCode,
  ...(run.stopped ? { stopped: run.stopped } : {}),
  ...(run.report ? { report: shownIn(directory, run.report) } : {}),
  log: shownIn(directory, `${folder}.log`),
})

/** A plan check as a claim, decided by the verdict rules from its runs and comparison. */
export async function planClaim(
  directory: string,
  check: VerifyCheck,
  runs: CheckResult[],
  context: {
    comparison?: Comparison
    changed: boolean
    baselinePresent: boolean
  },
): Promise<Claim> {
  const { comparison, changed, baselinePresent } = context
  const incomplete = incompleteOf(runs, comparison, baselinePresent)
  const execution = executionOf(runs)
  const decision = decideClaim({
    expectation: changed ? 'EXPECTATION_CHANGED' : 'present',
    attempts: runs.map((run) => ({
      completed: run.evidence?.complete === true,
      failed: sawFailure(run),
    })),
    execution,
    incomplete,
    failure: failureOf(comparison),
  })
  const folder = (n: number) => join(directory, 'after', check.name, `run-${n}`)
  return {
    id: checkClaim(check),
    kind: 'behavior',
    statement: planStatement(check),
    expectation: PLAN_EXPECTATION,
    ...decision,
    execution: {
      status: execution,
      attempts: runs.map((run, i) =>
        attemptOf(directory, run, i + 1, folder(i + 1)),
      ),
    },
    baseline: comparison
      ? { status: 'completed', comparison: comparison.verdict }
      : { status: baselinePresent ? 'completed' : 'missing' },
    evidence: await evidenceFiles(directory, runs),
    gaps: [
      ...new Set([
        ...incomplete,
        ...runs.flatMap((run) => run.evidence?.gaps ?? []),
      ]),
    ],
  }
}

/** The suspect scan of the changed lines as a claim: a suspect is a lead to prove or dismiss. */
export function suspectClaim(
  base: string,
  scan: { suspects: Suspect[]; error?: string },
  expectation: Expectation,
): Claim {
  const ran = scan.error === undefined
  const incomplete = scan.suspects.length ? ['SUSPECTS_ON_CHANGED_LINES'] : []
  const execution = ran ? 'completed' : 'failed-to-start'
  return {
    ...pendingSuspectClaim(base, expectation),
    ...decideClaim({
      expectation: 'present',
      attempts: ran ? [{ completed: true, failed: false }] : [],
      execution,
      incomplete,
      failure: 'NOT_COMPARABLE',
    }),
    execution: {
      status: execution,
      attempts: ran ? [{ side: 'candidate', n: 1 }] : [],
    },
    baseline: { status: 'not-applicable' },
    evidence: [],
    gaps: ran
      ? incomplete.map(
          (code) => `${code}: ${scan.suspects.length} to prove or dismiss`,
        )
      : [`FAILED_TO_START: ${scan.error}`],
  }
}
