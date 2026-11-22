import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunEvidence } from './compare/types.mjs'
import type { VerifyPlan } from './verify-plan.mjs'
import type { CheckResult } from './watch/checks.mjs'
import {
  changedSinceBaseline,
  readBaseline,
  verifyCheck,
  type Baseline,
  type CheckVerification,
} from './verify/check.mjs'
import { revisionsOf } from './verify/git.mjs'
import {
  attemptOf,
  checkClaim,
  pendingPlanClaims,
  PLAN_EXPECTATION,
  planClaim,
  suspectClaim,
} from './verify/plan-claims.mjs'
import { VerificationLog } from './verify/record.mjs'
import { folderOf, runSide, type VerifyOptions } from './verify/side.mjs'
import {
  finishVerification,
  scanChangedLines,
  scanReason,
  summarizedEvenIfStopped,
  type Verification,
} from './verify/summary.mjs'

export {
  verifyPlan,
  type VerifyCheck,
  type VerifyPlan,
} from './verify-plan.mjs'
export type { CheckVerification } from './verify/check.mjs'
export { verifyPolicy, type PolicyOptions } from './verify/policy-run.mjs'
export type { VerifyEvent, VerifyOptions } from './verify/side.mjs'
export type { Verification, VerificationFields } from './verify/summary.mjs'

/** Runs every check of the plan before the code changes, as the starting point. */
export async function recordBaseline(
  options: VerifyOptions,
): Promise<Map<string, CheckResult[]>> {
  const directory = folderOf(options)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  const results = await runSide('before', options)
  const baseline: Baseline = {
    at: new Date().toISOString(),
    checks: options.plan.checks,
  }
  await writeFile(
    join(directory, 'before', 'baseline.json'),
    `${JSON.stringify(baseline, null, 2)}\n`,
    { mode: 0o600 },
  )
  return results
}

/**
 * Runs every check of the plan after the change and compares it with the
 * baseline, then scans the changed lines for suspects. The change is verified
 * only when each check has complete runs on both sides and improved or stayed
 * clean, and no changed line is a suspect.
 */
export async function verifyChange(
  options: VerifyOptions,
): Promise<Verification> {
  const directory = folderOf(options)
  const { plan } = options
  const { baseline, before } = await readBaseline(directory, plan)
  const { revisions } = await revisionsOf(process.cwd(), plan.base)
  const log = await VerificationLog.start(
    directory,
    { mode: 'plan', revisions },
    pendingPlanClaims(plan),
  )
  const after = await summarizedEvenIfStopped(log, options.signal, () =>
    runSide('after', options, (check, n, result, folder) =>
      log.attempt(checkClaim(check), attemptOf(directory, result, n, folder)),
    ),
  )
  const checks = plan.checks.map((check) =>
    verifyCheck(
      check,
      baseline,
      before.get(check.name)!,
      after.get(check.name)!,
    ),
  )
  const reasons = checks
    .filter((check) => !check.verified)
    .map((check) => `${check.name}: ${check.reason}`)
  options.onEvent?.({ type: 'scanning', base: plan.base })
  const scan = await scanChangedLines(plan.base)
  const scanned = scanReason(scan)
  if (scanned) reasons.push(scanned)
  const regressed = checks.some((check) => check.comparison?.exitCode === 1)
  const fields = {
    verdict: reasons.length ? ('NOT_VERIFIED' as const) : ('VERIFIED' as const),
    exitCode: (!reasons.length ? 0 : regressed ? 1 : 2) as 0 | 1 | 2,
    reasons,
    checks,
    suspects: scan.suspects,
    directory,
  }
  const claims = [
    ...(await planClaims(directory, plan, after, { baseline, before, checks })),
    suspectClaim(plan.base, scan, PLAN_EXPECTATION),
  ]
  return finishVerification(log, fields, { status: 'completed', claims })
}

/** Each plan check as a claim, from its runs after the change and its comparison. */
function planClaims(
  directory: string,
  plan: VerifyPlan,
  after: Map<string, CheckResult[]>,
  {
    baseline,
    before,
    checks,
  }: {
    baseline: Baseline
    before: Map<string, RunEvidence[]>
    checks: CheckVerification[]
  },
) {
  return Promise.all(
    plan.checks.map((check, i) =>
      planClaim(directory, check, after.get(check.name)!, {
        comparison: checks[i].comparison,
        changed: changedSinceBaseline(check, baseline),
        baselinePresent:
          baseline.checks.some((earlier) => earlier.name === check.name) &&
          before.get(check.name)!.length > 0,
      }),
    ),
  )
}
