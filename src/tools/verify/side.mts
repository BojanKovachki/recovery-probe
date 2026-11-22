import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { VerifyCheck, VerifyPlan } from '../verify-plan.mjs'
import {
  runCheck,
  runRecoveryProbe,
  type CheckResult,
  type CheckRunner,
} from '../watch/checks.mjs'

export type Side = 'before' | 'after'

export type VerifyEvent =
  | { type: 'running'; side: Side; check: string; run: number }
  | { type: 'ran'; side: Side; check: string; result: CheckResult }
  | { type: 'scanning'; base: string }
  | { type: 'planned'; worstCaseMs: number; budgetMs: number }

export interface VerifyOptions {
  plan: VerifyPlan
  /** Where the runs are kept; .recovery-probe/verify by default. */
  directory?: string
  runCommand?: CheckRunner
  onEvent?: (event: VerifyEvent) => void
  /** Stops the run in progress and starts no more; recordBaseline and verifyChange then reject. */
  signal?: AbortSignal
}

export const folderOf = (options: { directory?: string }) =>
  resolve(options.directory ?? join('.recovery-probe', 'verify'))

/** Called after every run, for a record of a run still in progress. */
export type OnRun = (
  check: VerifyCheck,
  run: number,
  result: CheckResult,
  folder: string,
) => Promise<void>

export function stopIfAborted(side: Side, signal?: AbortSignal) {
  if (signal?.aborted)
    throw new Error(
      side === 'before'
        ? 'Stopped before the baseline was recorded: the earlier one is kept'
        : 'Stopped before the runs after the change finished: nothing was verified',
    )
}

/**
 * Runs every check of the plan for one side. The runs go to a new folder that replaces the
 * side's earlier runs only once every run has finished, so a stopped side keeps the last
 * complete one.
 */
export async function runSide(
  side: Side,
  options: VerifyOptions,
  onRun: OnRun = async () => {},
): Promise<Map<string, CheckResult[]>> {
  const final = join(folderOf(options), side)
  const next = `${final}.next`
  await rm(next, { recursive: true, force: true })
  await mkdir(next, { recursive: true, mode: 0o700 })
  const emit = options.onEvent ?? (() => {})
  const { signal } = options
  const results = new Map<string, CheckResult[]>()
  for (const check of options.plan.checks) {
    const runs: CheckResult[] = []
    await mkdir(join(next, check.name), { mode: 0o700 })
    for (let run = 1; run <= options.plan.runs; run++) {
      stopIfAborted(side, signal)
      emit({ type: 'running', side, check: check.name, run })
      const folder = join(next, check.name, `run-${run}`)
      const result = await runCheck(
        check.command,
        folder,
        options.runCommand ?? runRecoveryProbe,
        { signal },
      )
      await writeFile(`${folder}.log`, result.output, { mode: 0o600 })
      runs.push(result)
      emit({ type: 'ran', side, check: check.name, result })
      await onRun(check, run, result, folder)
    }
    results.set(check.name, runs)
  }
  stopIfAborted(side, signal)
  await rm(final, { recursive: true, force: true })
  await rename(next, final)
  const moved = (path: string) => join(final, relative(next, path))
  for (const runs of results.values())
    for (const run of runs) {
      if (run.report) run.report = moved(run.report)
      if (run.evidence) run.evidence.path = moved(run.evidence.path)
    }
  return results
}
