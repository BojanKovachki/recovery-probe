import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readRunEvidence } from './compare/reports.mjs'
import { compareRuns } from './compare/run.mjs'
import type { Comparison, RunEvidence } from './compare/types.mjs'
import {
  ensure,
  isIntegerIn,
  isNonEmptyString,
  isRecord,
} from '../core/validate.mjs'
import type { Suspect } from './suspects/source.mjs'
import { scanForSuspects } from './suspects/scan.mjs'
import {
  runCheck,
  runRecoveryProbe,
  validateCheckCommand,
  type CheckResult,
  type CommandResult,
} from './watch/checks.mjs'

const NAME = /^[\w.-]{1,40}$/

export interface VerifyCheck {
  name: string
  /** Recovery Probe arguments of the check, such as ["observe", "--config", "observe.json"]. */
  command: string[]
}

export interface VerifyPlan {
  /** The Git reference the change starts from; its changed lines are scanned for suspects. */
  base: string
  /** Runs of each check on each side. */
  runs: number
  checks: VerifyCheck[]
}

export function verifyPlan(input: unknown): VerifyPlan {
  ensure(isRecord(input), 'The plan must be { base?, runs?, checks }')
  const { base = 'main', runs = 3, checks, ...rest } = input
  const [unknown] = Object.keys(rest)
  if (unknown) throw new Error(`Unsupported plan option: ${unknown}`)
  ensure(isNonEmptyString(base), 'base must be a Git reference, such as main')
  ensure(isIntegerIn(runs, 1, 10), 'runs must be a whole number from 1 to 10')
  ensure(
    Array.isArray(checks) && checks.length > 0 && checks.length <= 20,
    'checks must list 1–20 { name, command } entries',
  )
  const plan: VerifyPlan = { base, runs, checks: [] }
  for (const [i, check] of checks.entries())
    plan.checks.push(planCheck(check, `checks[${i}]`, plan.checks))
  return plan
}

function planCheck(
  check: unknown,
  where: string,
  earlier: VerifyCheck[],
): VerifyCheck {
  const { name, command } = (check ?? {}) as Record<string, unknown>
  ensure(
    typeof name === 'string' && NAME.test(name),
    `${where}.name must match ${NAME}`,
  )
  ensure(
    !earlier.some((other) => other.name === name),
    `Check names must be unique: ${name}`,
  )
  ensure(
    Array.isArray(command) && command.every((arg) => typeof arg === 'string'),
    `${where}.command must be a list of arguments`,
  )
  validateCheckCommand(command)
  return { name, command: [...command] }
}

export type VerifyEvent =
  | { type: 'running'; side: 'before' | 'after'; check: string; run: number }
  | {
      type: 'ran'
      side: 'before' | 'after'
      check: string
      result: CheckResult
    }
  | { type: 'scanning'; base: string }

export interface VerifyOptions {
  plan: VerifyPlan
  /** Where the runs are kept; .recovery-probe/verify by default. */
  directory?: string
  runCommand?: (args: string[]) => Promise<CommandResult>
  onEvent?: (event: VerifyEvent) => void
}

interface Baseline {
  at: string
  checks: VerifyCheck[]
}

const folderOf = (options: VerifyOptions) =>
  resolve(options.directory ?? join('.recovery-probe', 'verify'))

// Each side replaces its earlier runs: a baseline is one starting point.
async function runSide(
  side: 'before' | 'after',
  options: VerifyOptions,
): Promise<Map<string, CheckResult[]>> {
  const directory = join(folderOf(options), side)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const emit = options.onEvent ?? (() => {})
  const results = new Map<string, CheckResult[]>()
  for (const check of options.plan.checks) {
    const runs: CheckResult[] = []
    await mkdir(join(directory, check.name), { mode: 0o700 })
    for (let run = 1; run <= options.plan.runs; run++) {
      emit({ type: 'running', side, check: check.name, run })
      const folder = join(directory, check.name, `run-${run}`)
      const result = await runCheck(
        check.command,
        folder,
        options.runCommand ?? runRecoveryProbe,
      )
      await writeFile(`${folder}.log`, result.output, { mode: 0o600 })
      runs.push(result)
      emit({ type: 'ran', side, check: check.name, result })
    }
    results.set(check.name, runs)
  }
  return results
}

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

export interface CheckVerification {
  name: string
  verified: boolean
  /** Why the check does not verify the change. */
  reason?: string
  comparison?: Comparison
}

export interface Verification {
  verdict: 'VERIFIED' | 'NOT_VERIFIED'
  /** 0: verified; 1: a new defect; 2: anything else that keeps it from being verified. */
  exitCode: 0 | 1 | 2
  reasons: string[]
  checks: CheckVerification[]
  suspects: Suspect[]
  directory: string
  markdown: string
}

const evidenceOf = (runs: CheckResult[]) =>
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

function verifyCheck(
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
  if (JSON.stringify(recorded.command) !== JSON.stringify(check.command))
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
async function readBaseline(directory: string, plan: VerifyPlan) {
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

/** The suspects on lines changed since `base`; adds to `reasons` when there are any. */
async function scanChangedLines(base: string, reasons: string[]) {
  try {
    const { suspects } = await scanForSuspects({
      changedSince: base,
      changedLinesOnly: true,
    })
    if (suspects.length)
      reasons.push(
        `${suspects.length} suspect(s) on changed lines: prove or dismiss each, and mark a reviewed line with // recovery-probe-ignore`,
      )
    return suspects
  } catch (error) {
    reasons.push(`the suspect scan did not run: ${(error as Error).message}`)
    return []
  }
}

function markdownOf(result: Omit<Verification, 'markdown'>): string {
  const lines = [
    `**Recovery Probe verify: ${result.verdict === 'VERIFIED' ? 'verified' : 'not verified'}**`,
    '',
    ...result.checks.map(
      (check) =>
        `- \`${check.name}\`: ${check.verified ? check.comparison!.summary : check.reason}`,
    ),
    result.suspects.length
      ? `- Suspects on changed lines: ${result.suspects.map((s) => `\`${s.file}:${s.line}\` ${s.pattern}`).join(', ')}`
      : '- No suspects on changed lines.',
  ]
  return `${lines.join('\n')}\n`
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
  const { baseline, before } = await readBaseline(directory, options.plan)
  const after = await runSide('after', options)
  const checks = options.plan.checks.map((check) =>
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
  options.onEvent?.({ type: 'scanning', base: options.plan.base })
  const suspects = await scanChangedLines(options.plan.base, reasons)
  const verdict = reasons.length ? 'NOT_VERIFIED' : 'VERIFIED'
  const result = {
    verdict,
    exitCode: !reasons.length
      ? 0
      : checks.some((check) => check.comparison?.exitCode === 1)
        ? 1
        : 2,
    reasons,
    checks,
    suspects,
    directory,
  } as const
  const markdown = markdownOf(result)
  await writeFile(join(directory, 'summary.md'), markdown, { mode: 0o600 })
  await writeFile(
    join(directory, 'summary.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  )
  return { ...result, markdown }
}
