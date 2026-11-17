import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { PlanInputError } from '../plan/changes.mjs'
import { safeOutputPath } from '../plan/output.mjs'
import { DEFAULT_REGISTRY, readRegistry } from '../plan/registry.mjs'
import {
  runCheck,
  runRecoveryProbe,
  type CheckResult,
  type CommandResult,
} from '../watch/checks.mjs'
import {
  cleanGuidance,
  differenceGuidance,
  executionGuidance,
  findingGuidance,
  gapGuidance,
  preflightGuidance,
  problemKey,
  type RunDifference,
  type SelfCheckRun,
} from './guidance.mjs'
import type { Preflight } from './preflight.mjs'
import { selection, type CheckEntry, type InvalidEntry } from './selection.mjs'
import { markdownOf } from './render.mjs'

export type { InvalidEntry, RunDifference, SelfCheckRun }

export const DEFAULT_SELF_CHECK = join('.recovery-probe', 'self-check')

export type SelfCheckOutcome =
  | 'configuration-error'
  | 'preflight-passed'
  | 'execution-failed'
  | 'incomplete'
  | 'inconsistent'
  | 'findings'
  | 'clean'

export interface ScenarioSelfCheck {
  name: string
  command: string[]
  preflight: Preflight
  runs: SelfCheckRun[]
  differences: RunDifference[]
  outcome: SelfCheckOutcome
  guidance: string[]
}

export interface SelfCheckReport {
  /** A check of the scenarios themselves. It never says the app is correct or a change verified. */
  kind: 'scenario-self-check'
  mode: 'static' | 'runtime'
  at: string
  registry: string
  /** The build the user said is running. Recovery Probe does not verify which code that is. */
  reference: { label: string; declaredBy: 'user' } | null
  runs: number
  /**
   * Every selected scenario clean (preflight passed, without a run), every name found, and no
   * invalid entry the selection concerns. It says nothing about the app.
   */
  passed: boolean
  scenarios: ScenarioSelfCheck[]
  /** Registry entries the self-check could not check. */
  invalidEntries: InvalidEntry[]
  /** Names asked for that the registry does not list. */
  unknown: string[]
  limits: string[]
}

export interface SelfCheckOptions {
  registry?: string
  /** The scenarios to check; every registered check by default. */
  names?: string[]
  /** Runs the scenarios against the reference build the user declares; static only without it. */
  run?: { reference: string; runs?: number; directory?: string }
  runCommand?: (args: string[]) => Promise<CommandResult>
}

const LIMITS = [
  'The reference build is the one you declared. Recovery Probe did not verify which code the running application contains.',
  'A clean self-check never means the application is correct, the scenario is effective, or a change is VERIFIED. It complements before/after verification and does not replace it.',
  'Running a scenario injects the faults and performs the actions its configuration names.',
  'Suggested causes are possibilities to investigate, not diagnoses.',
]

const shown = (path: string) => relative('.', path).split(sep).join('/')

/** The run as the report shows it, with how each CONTENT_BEFORE_READ came about. */
async function runOf(run: number, result: CheckResult): Promise<SelfCheckRun> {
  const base = { run, exitCode: result.exitCode }
  if (!result.evidence || !result.report)
    return {
      ...base,
      gaps: [],
      problems: [],
      error: result.error ?? 'no report',
    }
  const raw = JSON.parse(await readFile(result.report, 'utf8'))
  const bases: string[] = (Array.isArray(raw.findings) ? raw.findings : [])
    .filter((f: { code?: string }) => f.code === 'CONTENT_BEFORE_READ')
    .flatMap((f: { basis?: unknown }) =>
      typeof f.basis === 'string' ? [f.basis] : [],
    )
  return {
    ...base,
    report: shown(result.report),
    complete: result.evidence.complete,
    gaps: result.evidence.gaps,
    problems: result.evidence.problems,
    ...(bases.length ? { contentBeforeRead: [...new Set(bases)] } : {}),
    // A report that records an error is a run that could not do its work.
    ...(typeof raw.error === 'string' && raw.error ? { error: raw.error } : {}),
  }
}

/** Problems and gaps some of the runs that did their work had and others did not. */
function differencesOf(runs: SelfCheckRun[]): RunDifference[] {
  const reported = runs.filter((run) => !run.error)
  const differences: RunDifference[] = []
  for (const kind of ['problem', 'gap'] as const) {
    const codesOf = (run: SelfCheckRun) =>
      kind === 'gap' ? run.gaps : run.problems.map(problemKey)
    for (const code of [...new Set(reported.flatMap(codesOf))].sort()) {
      const presentIn = reported
        .filter((r) => codesOf(r).includes(code))
        .map((r) => r.run)
      if (presentIn.length < reported.length)
        differences.push({
          kind,
          code,
          presentIn,
          absentIn: reported
            .filter((r) => !presentIn.includes(r.run))
            .map((r) => r.run),
        })
    }
  }
  return differences
}

/** The outcome and guidance of a scenario that ran, by the first that applies. */
function classify(
  runs: SelfCheckRun[],
  differences: RunDifference[],
  preflight: Preflight,
) {
  if (runs.some((run) => run.error))
    return {
      outcome: 'execution-failed' as const,
      guidance: executionGuidance(runs, preflight.requires),
    }
  if (runs.some((run) => !run.complete))
    return { outcome: 'incomplete' as const, guidance: gapGuidance(runs) }
  if (differences.some((d) => d.kind === 'problem'))
    return {
      outcome: 'inconsistent' as const,
      guidance: differenceGuidance(differences),
    }
  if (runs[0].problems.length)
    return { outcome: 'findings' as const, guidance: findingGuidance(runs) }
  return { outcome: 'clean' as const, guidance: cleanGuidance(runs.length) }
}

/** Where the scenarios that pass the preflight run, how often, and with what. */
interface RunPlan {
  directory: string
  runs: number
  runCommand: (args: string[]) => Promise<CommandResult>
}

/** Runs the scenario `runs` times, one after another, each into its own folder. */
async function runScenario(
  entry: CheckEntry,
  { directory, runs: count, runCommand }: RunPlan,
) {
  const folder = join(directory, 'runs', entry.name)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const runs: SelfCheckRun[] = []
  for (let run = 1; run <= count; run++) {
    const result = await runCheck(
      entry.check,
      join(folder, `run-${run}`),
      runCommand,
    )
    await writeFile(join(folder, `run-${run}.log`), result.output, {
      mode: 0o600,
    })
    runs.push(await runOf(run, result))
  }
  return runs
}

async function selfCheckScenario(
  entry: CheckEntry,
  plan: RunPlan | undefined,
): Promise<ScenarioSelfCheck> {
  // An entry too malformed for a preflight has only its registry problem.
  const preflight = entry.preflight ?? {
    errors: [entry.problem ?? 'the registry entry is malformed'],
    unresolved: [],
    requires: [],
    inputs: [],
  }
  const base = {
    name: entry.name,
    command: entry.check,
    preflight,
    runs: [],
    differences: [],
  }
  if (preflight.errors.length || preflight.unresolved.length)
    return {
      ...base,
      outcome: 'configuration-error',
      guidance: preflightGuidance(preflight),
    }
  if (!plan) return { ...base, outcome: 'preflight-passed', guidance: [] }
  const runs = await runScenario(entry, plan)
  const differences = differencesOf(runs)
  return {
    ...base,
    runs,
    differences,
    ...classify(runs, differences, preflight),
  }
}

/**
 * A folder for this self-check's runs and report, its earlier runs removed. The files it writes
 * there are checked for links before anything runs.
 */
async function outputFolder(path: string) {
  const directory = await safeOutputPath(path, 'self-check')
  for (const file of ['.gitignore', 'report.json', 'report.md'])
    await safeOutputPath(`${directory}/${file}`, 'self-check')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  await rm(join(directory, 'runs'), { recursive: true, force: true })
  return directory
}

/**
 * Checks registered scenarios. Without `run`, only statically: nothing is started or contacted.
 * With `run`, each scenario that passes runs `runs` times (3 by default) against the application
 * the user declares as the reference, and the runs are compared.
 */
export async function selfCheck(
  options: SelfCheckOptions,
): Promise<SelfCheckReport> {
  const registry = options.registry ?? DEFAULT_REGISTRY
  if (!existsSync(registry))
    throw new PlanInputError(
      `No registry at ${registry}: see docs/plan.md for its format`,
    )
  const run = runSettings(options.run)
  const { chosen, invalid, unknown } = selection(
    await readRegistry(registry, process.cwd()),
    options.names,
  )
  const plan = run && {
    directory: await outputFolder(run.directory),
    runs: run.runs,
    runCommand: options.runCommand ?? runRecoveryProbe,
  }
  const scenarios: ScenarioSelfCheck[] = []
  for (const entry of chosen)
    scenarios.push(await selfCheckScenario(entry, plan))
  const report: SelfCheckReport = {
    kind: 'scenario-self-check',
    mode: run ? 'runtime' : 'static',
    at: new Date().toISOString(),
    registry,
    reference: run ? { label: run.reference, declaredBy: 'user' } : null,
    runs: run?.runs ?? 0,
    passed: passedOf(
      scenarios,
      run ? 'clean' : 'preflight-passed',
      invalid,
      unknown,
    ),
    scenarios,
    invalidEntries: invalid,
    unknown,
    limits: LIMITS,
  }
  if (plan) await writeReport(plan.directory, report)
  return report
}

/** See SelfCheckReport.passed. */
const passedOf = (
  scenarios: ScenarioSelfCheck[],
  wanted: SelfCheckOutcome,
  invalid: InvalidEntry[],
  unknown: string[],
) =>
  scenarios.length > 0 &&
  scenarios.every((s) => s.outcome === wanted) &&
  !invalid.some((e) => e.selected) &&
  !unknown.length

/** The run options with their defaults, or why they can't be used. */
function runSettings(run: SelfCheckOptions['run']) {
  if (!run) return undefined
  const runs = run.runs ?? 3
  if (!Number.isInteger(runs) || runs < 1 || runs > 10)
    throw new PlanInputError('runs must be a whole number from 1 to 10')
  if (!run.reference.trim())
    throw new PlanInputError(
      'Name the reference build the application is running',
    )
  return {
    reference: run.reference.trim(),
    runs,
    directory: run.directory ?? DEFAULT_SELF_CHECK,
  }
}

async function writeReport(directory: string, report: SelfCheckReport) {
  await writeFile(
    join(directory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  )
  await writeFile(join(directory, 'report.md'), markdownOf(report), {
    mode: 0o600,
  })
}
