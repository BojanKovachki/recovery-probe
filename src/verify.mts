import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  compareRuns,
  readRunEvidence,
  type Comparison,
  type RunEvidence,
} from './compare.mjs'
import { scanForSuspects, type Suspect } from './suspects.mjs'
import {
  runCheck,
  runRecoveryProbe,
  validateCheckCommand,
  type CheckResult,
  type CommandResult,
} from './watch.mjs'

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
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('The plan must be { base?, runs?, checks }')
  const {
    base = 'main',
    runs = 3,
    checks,
    ...rest
  } = input as Record<string, unknown>
  const [unknown] = Object.keys(rest)
  if (unknown) throw new Error(`Unsupported plan option: ${unknown}`)
  if (typeof base !== 'string' || !base.trim())
    throw new Error('base must be a Git reference, such as main')
  if (
    typeof runs !== 'number' ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 10
  )
    throw new Error('runs must be a whole number from 1 to 10')
  if (!Array.isArray(checks) || !checks.length || checks.length > 20)
    throw new Error('checks must list 1–20 { name, command } entries')
  const plan: VerifyPlan = { base, runs, checks: [] }
  for (const [i, check] of checks.entries()) {
    const { name, command } = (check ?? {}) as Record<string, unknown>
    if (typeof name !== 'string' || !NAME.test(name))
      throw new Error(`checks[${i}].name must match ${NAME}`)
    if (plan.checks.some((earlier) => earlier.name === name))
      throw new Error(`Check names must be unique: ${name}`)
    if (
      !Array.isArray(command) ||
      command.some((arg) => typeof arg !== 'string')
    )
      throw new Error(`checks[${i}].command must be a list of arguments`)
    validateCheckCommand(command)
    plan.checks.push({ name, command: [...command] })
  }
  return plan
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

function verifyCheck(
  check: VerifyCheck,
  baseline: Baseline,
  before: RunEvidence[],
  after: CheckResult[],
): CheckVerification {
  const recorded = baseline.checks.find(
    (earlier) => earlier.name === check.name,
  )
  if (!recorded || !before.length)
    return {
      name: check.name,
      verified: false,
      reason: 'no runs from before the change: run verify --baseline first',
    }
  if (JSON.stringify(recorded.command) !== JSON.stringify(check.command))
    return {
      name: check.name,
      verified: false,
      reason: 'the check changed since the baseline: record it again',
    }
  const afterEvidence = evidenceOf(after)
  if (!afterEvidence.length)
    return {
      name: check.name,
      verified: false,
      reason: `no run after the change wrote a report (${after.find((run) => run.error)?.error ?? 'no report'})`,
    }
  const comparison = compareRuns(before, afterEvidence, {
    before: 'before',
    after: 'after',
  })
  const incomplete = after.filter((run) => !run.evidence?.complete).length
  if (incomplete)
    return {
      name: check.name,
      verified: false,
      reason: `${incomplete} of ${after.length} runs after the change were incomplete`,
      comparison,
    }
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
  const baselineFile = join(directory, 'before', 'baseline.json')
  if (!existsSync(baselineFile))
    throw new Error(
      'No baseline: run verify --baseline before changing the code',
    )
  const baseline: Baseline = JSON.parse(await readFile(baselineFile, 'utf8'))
  const before = new Map<string, RunEvidence[]>()
  for (const check of options.plan.checks) {
    const reports = Array.from({ length: options.plan.runs }, (_, i) =>
      join(directory, 'before', check.name, `run-${i + 1}`, 'report.json'),
    ).filter((report) => existsSync(report))
    before.set(check.name, await Promise.all(reports.map(readRunEvidence)))
  }
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
  let suspects: Suspect[] = []
  try {
    ;({ suspects } = await scanForSuspects({
      changedSince: options.plan.base,
      changedLinesOnly: true,
    }))
    if (suspects.length)
      reasons.push(
        `${suspects.length} suspect(s) on changed lines: prove or dismiss each, and mark a reviewed line with // recovery-probe-ignore`,
      )
  } catch (error) {
    reasons.push(`the suspect scan did not run: ${(error as Error).message}`)
  }
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
