import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Suspect } from '../suspects/source.mjs'
import { scanForSuspects } from '../suspects/scan.mjs'
import { verifyPlan, type VerifyPlan } from '../verify.mjs'
import { baselineStatus, type BaselineStatus } from './baseline.mjs'
import { changesSince, PlanInputError, type ChangedFile } from './changes.mjs'
import {
  readRegistry,
  safeRelativePath,
  type Registry,
  type RegistryEntry,
} from './registry.mjs'
import {
  importSuggestions,
  selections,
  stalePatterns,
  type Selection,
  type Suggestion,
} from './select.mjs'
import { gapsOf, type InputRequest } from './gaps.mjs'

export const DEFAULT_REGISTRY = 'recovery-probe.registry.json'
export const DEFAULT_PLAN = join('.recovery-probe', 'verify.json')

export interface PlanOptions {
  /** The Git reference the change starts from. */
  base: string
  registry?: string
  /** What the change is for, kept as given: data for the reader, never instructions. */
  task?: string
  /** Expectations the user states for registry entries that have none, by entry name. */
  expectations?: Record<string, string>
  runs?: number
  /** Files left out of the change, such as the plan being written. */
  ignored?: string[]
}

/** One check to run, with every reason it was selected. */
export interface PlannedCheck {
  name: string
  command: string[]
  scenarios: {
    entry: string
    behavior: string
    expectation: string
    /** Where the expectation came from: the registry, or the user for this plan. */
    expectationFrom: 'registry' | 'user'
    notCovered: string
  }[]
  selectedBy: Selection[]
  /** Suspects on the changed lines of the files that selected it. */
  suspects: Suspect[]
}

export interface PlanReport {
  /** A proposal of what to verify. It never says whether a change is verified. */
  kind: 'verification-plan'
  base: { ref: string; commit: string }
  registry: string | null
  task?: string
  changes: ChangedFile[]
  checks: PlannedCheck[]
  suggestions: (Suggestion & { reason: string })[]
  /** Changed files nothing in the registry concerns. */
  uncovered: (ChangedFile & { suspects: Suspect[] })[]
  needsInput: InputRequest[]
  suspects: { scanned: boolean; error?: string; onChangedLines: Suspect[] }
  baseline: BaselineStatus
  /** A verify plan of the explicit matches, or null when none can run yet. */
  candidatePlan: VerifyPlan | null
  /** How many suggestions, uncovered files and requests for input need a person. */
  gaps: number
  limits: string[]
}

const LIMITS = [
  'A plan proposes checks; it never says a change is verified. Run verify with a baseline from before the change for that.',
  'No matching check never means a change is safe: uncovered files have no known runtime check at all.',
  'Each check covers only the read, screen and expectation its configuration names.',
  'Selection follows the registry and one step of relative imports; it does not analyze the whole program.',
]

async function scanSuspects(base: string, root: string) {
  try {
    const { suspects } = await scanForSuspects({
      changedSince: base,
      changedLinesOnly: true,
    })
    const onChangedLines = suspects.map((suspect) => ({
      ...suspect,
      file: relative(root, resolve(suspect.file)).split(sep).join('/'),
    }))
    return { scanned: true, onChangedLines }
  } catch (error) {
    return {
      scanned: false,
      error: (error as Error).message,
      onChangedLines: [],
    }
  }
}

const suspectsIn = (suspects: Suspect[], files: string[]) =>
  suspects.filter((suspect) => files.includes(suspect.file))

/** The planned checks: entries with a valid check and a known expectation, one per command. */
function plannedChecks(
  found: Selection[],
  entries: RegistryEntry[],
  options: PlanOptions,
  suspects: Suspect[],
): PlannedCheck[] {
  const byCommand = new Map<string, PlannedCheck>()
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const selectedBy = found.filter((s) => s.entry === entry.name)
    const expectation = entry.expectation ?? options.expectations?.[entry.name]
    if (!selectedBy.length || !entry.check || entry.problem || !expectation)
      continue
    const key = JSON.stringify(entry.check)
    const check = byCommand.get(key) ?? {
      name: entry.name,
      command: entry.check,
      scenarios: [],
      selectedBy: [],
      suspects: [],
    }
    check.scenarios.push({
      entry: entry.name,
      behavior: entry.behavior!,
      expectation,
      expectationFrom: entry.expectation ? 'registry' : 'user',
      notCovered:
        entry.limits ??
        'The registry does not say; review what this check leaves out.',
    })
    check.selectedBy.push(...selectedBy)
    byCommand.set(key, check)
  }
  for (const check of byCommand.values())
    check.suspects = suspectsIn(
      suspects,
      check.selectedBy.map((s) => s.file),
    )
  return [...byCommand.values()]
}

/** The verify plan of the planned checks, or null when there are none or too many. */
function candidateOf(checks: PlannedCheck[], options: PlanOptions) {
  if (!checks.length || checks.length > 20) return null
  return verifyPlan({
    base: options.base,
    runs: options.runs ?? 3,
    checks: checks.map(({ name, command }) => ({ name, command })),
  })
}

/**
 * Writes the candidate plan to `path`, inside the working directory, and returns where; nothing
 * when there is no candidate. An existing file is replaced only with `force`.
 */
export async function writeCandidatePlan(
  report: PlanReport,
  path: string,
  force = false,
): Promise<string | undefined> {
  if (!report.candidatePlan) return undefined
  const safe = safeRelativePath(path)
  if (!safe)
    throw new PlanInputError(
      `Write the plan inside the working directory, with a relative path: ${path}`,
    )
  if (existsSync(safe) && !force)
    throw new PlanInputError(
      `${safe} already exists: review it, then replace it with the force option`,
    )
  await mkdir(dirname(resolve(safe)), { recursive: true })
  await writeFile(safe, `${JSON.stringify(report.candidatePlan, null, 2)}\n`)
  return safe
}

const loadRegistry = (path: string, cwd: string): Promise<Registry | null> =>
  existsSync(path) ? readRegistry(path, cwd) : Promise.resolve(null)

/** The suggestions for changed files no entry concerns, each with its reason. */
async function suggestionsFor(
  root: string,
  entries: RegistryEntry[],
  changes: ChangedFile[],
  found: Selection[],
) {
  const unlisted = changes.filter((c) => !found.some((s) => s.file === c.path))
  const order = (s: Suggestion) => `${s.file}\0${s.entry}`
  return (await importSuggestions(root, entries, unlisted))
    .sort((a, b) => (order(a) < order(b) ? -1 : 1))
    .map((s) => ({
      ...s,
      reason: `${s.importedBy} imports it, and ${s.entry} lists ${s.importedBy}. Review whether that check exercises this change; it is not planned until the registry lists the file.`,
    }))
}

/**
 * Proposes the checks that verify the change since `options.base`, from an explicit registry of
 * scenarios. Reads Git, the registry, the check files it names and the changed sources; runs no
 * check, starts no app and changes no project file.
 */
export async function planVerification(
  options: PlanOptions,
): Promise<PlanReport> {
  const cwd = process.cwd()
  const registryPath = options.registry ?? DEFAULT_REGISTRY
  const ignored = (options.ignored ?? [DEFAULT_PLAN]).map((p) =>
    resolve(cwd, p),
  )
  const { root, commit, changes } = await changesSince(options.base, {
    cwd,
    ignored,
  })
  const registry = await loadRegistry(registryPath, cwd)
  const selected = await select(root, changes, registry, options)
  const { suggestions, uncovered, needsInput } = selected
  return {
    kind: 'verification-plan',
    base: { ref: options.base, commit },
    registry: registry ? registryPath : null,
    ...(options.task ? { task: options.task.slice(0, 2000) } : {}),
    changes,
    ...selected,
    baseline: await baselineStatus(resolve('.recovery-probe', 'verify'), {
      root,
      ref: options.base,
      plan: selected.candidatePlan,
      changes,
    }),
    gaps: suggestions.length + uncovered.length + needsInput.length,
    limits: LIMITS,
  }
}

/** The checks the registry selects for the changes, and everything it leaves open. */
async function select(
  root: string,
  changes: ChangedFile[],
  registry: Registry | null,
  options: PlanOptions,
) {
  const entries = registry?.entries ?? []
  const found = selections(changes, entries)
  const suspects = await scanSuspects(options.base, root)
  const checks = plannedChecks(found, entries, options, suspects.onChangedLines)
  const suggestions = await suggestionsFor(root, entries, changes, found)
  const deleted = changes
    .filter((c) => c.status === 'deleted')
    .map((c) => c.path)
  const { uncovered, needsInput } = gapsOf({
    registry,
    registryPath: options.registry ?? DEFAULT_REGISTRY,
    changes,
    found,
    suggestions,
    suspects: suspects.onChangedLines,
    stale: await stalePatterns(root, entries, deleted),
    expectations: options.expectations ?? {},
    planned: checks.length,
  })
  const candidatePlan = candidateOf(checks, options)
  return { checks, suggestions, uncovered, needsInput, suspects, candidatePlan }
}
