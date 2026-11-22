import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareRuns } from '../compare/run.mjs'
import { checkJsonFiles } from '../scenarios/preflight.mjs'
import {
  runCheck,
  runRecoveryProbe,
  type CheckResult,
} from '../watch/checks.mjs'
import { openBrowser, startApp, type AppBrowser } from './apps.mjs'
import { withApprovedFiles, type BehaviorCriteria } from './criteria.mjs'
import { attemptOf, executionOf } from './plan-claims.mjs'
import { setupOnce } from './project-checks.mjs'
import type { PolicyClaim } from './policy.mjs'
import type { PolicyContext } from './policy-claims.mjs'
import type { ExecutionStatus } from './rules.mjs'
import { stopIfAborted } from './side.mjs'

export type ScenarioPath = 'failure' | 'normal'
type Side = 'base' | 'candidate'
type Scenarios = NonNullable<BehaviorCriteria['scenarios']>

export interface SideResult {
  status: ExecutionStatus
  runs: { path: ScenarioPath; result: CheckResult }[]
  /** Why the side stopped short, such as APP_LAUNCH_FAILED: …. */
  gap?: string
}

const approvedFolder = (context: PolicyContext) =>
  join(context.directory, 'policy', 'approved')

/**
 * `command` with its own copy of the approved configuration, next to the run's folder: attached
 * to the side's browser, and a discovery capped at the run's limit. The approved copy stays as
 * the base has it.
 */
async function forRun(
  command: string[],
  out: string,
  { cdp, capMs }: { cdp?: string; capMs: number },
) {
  const discovery = command[0] === 'discover'
  if (!cdp && !discovery) return command
  const config = checkJsonFiles(command).config
  const parsed = JSON.parse(await readFile(config, 'utf8'))
  if (cdp) parsed.cdp = cdp
  if (discovery)
    parsed.maxDurationMs = Math.min(parsed.maxDurationMs ?? capMs, capMs)
  const copy = `${out}.config.json`
  await writeFile(copy, JSON.stringify(parsed, null, 2), { mode: 0o600 })
  return command.map((arg, i) =>
    arg === config && command[i - 1] === '--config'
      ? copy
      : arg === `--config=${config}`
        ? `--config=${copy}`
        : arg,
  )
}

const exhausted = (runs: SideResult['runs']): SideResult => ({
  status: 'budget-exhausted',
  runs,
  gap: 'BUDGET_EXHAUSTED: the rest of the runs would not fit in the budget',
})

/**
 * Runs both scenarios `runs` times with the base's approved files. A run starts only when its
 * cap still fits in the budget, and is stopped at that cap.
 */
async function runPaths(
  context: PolicyContext,
  claim: PolicyClaim,
  scenarios: Scenarios,
  target: { side: Side; browser?: AppBrowser },
): Promise<SideResult> {
  const { directory, log, options, policy, budget } = context
  const capMs = policy.budgets.scenarioRunMs
  const folder = join(directory, 'policy', target.side, claim.id)
  const runs: SideResult['runs'] = []
  for (const path of ['failure', 'normal'] as const) {
    const approved = withApprovedFiles(
      context.sides,
      scenarios[path],
      approvedFolder(context),
    )
    for (let n = 1; n <= policy.runs; n++) {
      stopIfAborted('after', options.signal)
      if (!budget.fits(capMs)) return exhausted(runs)
      await target.browser?.reset()
      const out = join(folder, `${path}-${n}`)
      const command = await forRun(approved, out, {
        cdp: target.browser?.cdp,
        capMs,
      })
      const check = `${claim.id} ${path}`
      options.onEvent?.({ type: 'running', side: 'after', check, run: n })
      const run = options.runCommand ?? runRecoveryProbe
      const result = await runCheck(command, out, run, {
        signal: options.signal,
        timeoutMs: capMs,
      })
      await writeFile(`${out}.log`, result.output, { mode: 0o600 })
      options.onEvent?.({ type: 'ran', side: 'after', check, result })
      const attempt = {
        ...attemptOf(directory, result, n, out),
        side: target.side,
        path,
        against: 'approvedVersion' as const,
      }
      await log.attempt(`behavior/${claim.id}`, attempt)
      runs.push({ path, result })
    }
  }
  return { status: executionOf(runs.map((run) => run.result)), runs }
}

/** Runs the claim against an app someone started by hand: the candidate side only. */
export async function runAgainstRunningApp(
  context: PolicyContext,
  claim: PolicyClaim,
  scenarios: Scenarios,
) {
  await mkdir(join(context.directory, 'policy', 'candidate', claim.id), {
    recursive: true,
    mode: 0o700,
  })
  return runPaths(context, claim, scenarios, { side: 'candidate' })
}

/** Runs the claim against `side`'s own launch of its app, from that side's checkout. */
export async function runOnSide(
  context: PolicyContext,
  claim: PolicyClaim,
  scenarios: Scenarios,
  side: Side,
): Promise<SideResult> {
  const { policy, budget } = context
  const app = policy.apps[claim.app!]
  const folder = join(context.directory, 'policy', side, claim.id)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  if (!budget.fits(app.ready.timeoutMs + policy.budgets.scenarioRunMs))
    return exhausted([])
  let started
  let browser: AppBrowser | undefined
  try {
    const failure = await setupOnce(context, side)
    if (failure) throw new Error(`setup failed: ${failure}`)
    const checkout = (await context.checkouts())[side]
    started = await startApp(app, checkout, {
      sides: context.sides,
      setupTimeoutMs: Math.max(1000, budget.workLeftMs()),
    })
    browser = await openBrowser(app.url)
    return await runPaths(context, claim, scenarios, { side, browser })
  } catch (error) {
    if (!started || !browser)
      return {
        status: 'failed-to-start',
        runs: [],
        gap: `APP_LAUNCH_FAILED: ${(error as Error).message}`,
      }
    throw error
  } finally {
    await browser?.close().catch(() => {})
    await started?.stop()
    if (started)
      await writeFile(join(folder, 'app.log'), started.output(), {
        mode: 0o600,
      })
  }
}

/** What the base and candidate runs of each path say together, as compare decides. */
export function compareSides(base: SideResult, candidate: SideResult) {
  const evidence = (side: SideResult, path: ScenarioPath) =>
    side.runs.flatMap((run) =>
      run.path === path && run.result.evidence ? [run.result.evidence] : [],
    )
  const comparisons = (['failure', 'normal'] as const).map((path) => {
    const before = evidence(base, path)
    const after = evidence(candidate, path)
    return before.length && after.length
      ? compareRuns(before, after, { before: 'base', after: 'candidate' })
      : undefined
  })
  const failure = comparisons.some((comparison) => comparison?.exitCode === 1)
    ? 'NEW_FAILURE'
    : base.status === 'completed' && comparisons.every(Boolean)
      ? 'FAILING_ON_BOTH'
      : 'NOT_COMPARABLE'
  return { failure, verdict: comparisons[0]?.verdict }
}
