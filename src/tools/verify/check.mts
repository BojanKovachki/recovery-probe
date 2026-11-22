import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readRunEvidence } from '../compare/reports.mjs'
import { compareRuns } from '../compare/run.mjs'
import type { Comparison, RunEvidence } from '../compare/types.mjs'
import type { VerifyCheck, VerifyPlan } from '../verify-plan.mjs'
import type { CheckResult } from '../watch/checks.mjs'

export interface Baseline {
  at: string
  checks: VerifyCheck[]
}

export interface CheckVerification {
  name: string
  verified: boolean
  /** Why the check does not verify the change. */
  reason?: string
  comparison?: Comparison
}

export const evidenceOf = (runs: CheckResult[]) =>
  runs.flatMap((run) => (run.evidence ? [run.evidence] : []))

const problemsIn = (runs: RunEvidence[]) => runs.flatMap((run) => run.problems)

const unverified = (
  name: string,
  reason: string,
  comparison?: Comparison,
): CheckVerification => ({
  name,
  verified: false,
  reason,
  ...(comparison ? { comparison } : {}),
})

/** The baseline no longer stands for this check: it ran a different command. */
export const changedSinceBaseline = (
  check: VerifyCheck,
  baseline: Baseline,
) => {
  const recorded = baseline.checks.find(
    (earlier) => earlier.name === check.name,
  )
  return (
    recorded !== undefined &&
    JSON.stringify(recorded.command) !== JSON.stringify(check.command)
  )
}

export function verifyCheck(
  check: VerifyCheck,
  baseline: Baseline,
  before: RunEvidence[],
  after: CheckResult[],
): CheckVerification {
  const { name } = check
  const recorded = baseline.checks.find((earlier) => earlier.name === name)
  if (!recorded || !before.length)
    return unverified(
      name,
      'no runs from before the change: run verify --baseline first',
    )
  if (changedSinceBaseline(check, baseline))
    return unverified(
      name,
      'the check changed since the baseline: record it again',
    )
  const afterEvidence = evidenceOf(after)
  if (!afterEvidence.length)
    return unverified(
      name,
      `no run after the change wrote a report (${after.find((run) => run.error)?.error ?? 'no report'})`,
    )
  const comparison = compareRuns(before, afterEvidence, {
    before: 'before',
    after: 'after',
  })
  const incomplete = after.filter((run) => !run.evidence?.complete).length
  if (incomplete)
    return unverified(
      name,
      `${incomplete} of ${after.length} runs after the change were incomplete`,
      comparison,
    )
  const clean =
    comparison.verdict === 'IMPROVED' ||
    (comparison.verdict === 'UNCHANGED' && !problemsIn(afterEvidence).length)
  return {
    name: check.name,
    verified: clean,
    ...(clean
      ? {}
      : { reason: `${comparison.verdict}: ${comparison.summary}` }),
    comparison,
  }
}

/** The baseline and the reports its runs wrote, by check. */
export async function readBaseline(directory: string, plan: VerifyPlan) {
  const baselineFile = join(directory, 'before', 'baseline.json')
  if (!existsSync(baselineFile))
    throw new Error(
      'No baseline: run verify --baseline before changing the code',
    )
  const baseline: Baseline = JSON.parse(await readFile(baselineFile, 'utf8'))
  const before = new Map<string, RunEvidence[]>()
  for (const check of plan.checks) {
    const reports = Array.from({ length: plan.runs }, (_, i) =>
      join(directory, 'before', check.name, `run-${i + 1}`, 'report.json'),
    ).filter((report) => existsSync(report))
    before.set(check.name, await Promise.all(reports.map(readRunEvidence)))
  }
  return { baseline, before }
}
