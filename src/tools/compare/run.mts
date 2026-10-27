import { scoped, type Problem } from '../../reports/evidence.mjs'
import { toMarkdown } from './markdown.mjs'
import { readRunEvidence, reportFiles } from './reports.mjs'
import type {
  ChangeStatus,
  Comparison,
  ProblemChange,
  RunEvidence,
  SideCount,
} from './types.mjs'
import { verdictOf } from './verdict.mjs'

const keyOf = (problem: Problem) => scoped(problem.code, problem.scope)

function count(runs: RunEvidence[], problem: Problem): SideCount {
  const key = keyOf(problem)
  return {
    found: runs.filter((run) => run.problems.some((p) => keyOf(p) === key))
      .length,
    runs: runs.length,
    checked: runs.filter((run) => run.checked.includes(problem.scope ?? ''))
      .length,
  }
}

function statusOf(before: SideCount, after: SideCount): ChangeStatus {
  if (before.found && after.found) return 'STILL'
  if (before.found) return after.checked ? 'GONE' : 'UNVERIFIED'
  return before.checked ? 'NEW' : 'UNVERIFIED'
}

// Runs are the same check when their workflows match and their transports don't differ.
function mismatches(runs: RunEvidence[]): string[] {
  const [first] = runs
  const differs = runs.some(
    (run) =>
      run.workflow !== first.workflow ||
      (run.transport && first.transport && run.transport !== first.transport),
  )
  if (differs)
    return [
      `different checks: ${[...new Set(runs.map((run) => run.mode))].join(' and ')}`,
    ]
  const targets = [...new Set(runs.map((run) => run.target ?? 'none'))]
  return targets.length > 1
    ? [`different targets: ${targets.join(' and ')}`]
    : []
}

const ORDER: ChangeStatus[] = ['NEW', 'STILL', 'GONE', 'UNVERIFIED']

/** Each problem either side found, with how often, sorted new first. */
function changesOf(
  before: RunEvidence[],
  after: RunEvidence[],
): ProblemChange[] {
  const problems = new Map<string, Problem>()
  for (const run of [...before, ...after])
    for (const problem of run.problems)
      if (!problems.has(keyOf(problem))) problems.set(keyOf(problem), problem)
  return [...problems.values()]
    .map((problem) => {
      const counts = {
        before: count(before, problem),
        after: count(after, problem),
      }
      return {
        code: problem.code,
        ...(problem.scope ? { scope: problem.scope } : {}),
        severity: problem.severity,
        status: statusOf(counts.before, counts.after),
        ...counts,
      }
    })
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
}

const outcomesOf = (runs: RunEvidence[]) => [
  ...new Set(runs.flatMap((run) => run.outcomes)),
]

/**
 * Compares reports of the same check from before and after a change. A problem
 * counts as found from any run, but as gone only when a complete run after the
 * change checked it, so a run that stopped early never reads as a fix.
 */
export function compareRuns(
  before: RunEvidence[],
  after: RunEvidence[],
  labels: { before?: string; after?: string } = {},
): Comparison {
  if (!before.length || !after.length)
    throw new Error('Compare needs at least one report on each side')
  const mismatch = mismatches([...before, ...after])
  const changes = changesOf(before, after)
  const comparison = {
    ...verdictOf(changes, before, after, mismatch),
    ...(mismatch.length
      ? {}
      : { mode: before[0].mode, target: before[0].target }),
    labels: {
      before: labels.before ?? 'before',
      after: labels.after ?? 'after',
    },
    before,
    after,
    changes,
    outcomes: { before: outcomesOf(before), after: outcomesOf(after) },
    mismatch,
    limitation: after.find((run) => run.limitation)?.limitation,
  }
  return { ...comparison, markdown: toMarkdown(comparison) }
}

/** Reads both sides' reports (files, report folders or folders of runs) and compares them. */
export async function compareReports(
  before: string[],
  after: string[],
  labels: { before?: string; after?: string } = {},
): Promise<Comparison> {
  const read = async (paths: string[]) =>
    Promise.all(
      (await Promise.all(paths.map(reportFiles))).flat().map(readRunEvidence),
    )
  return compareRuns(await read(before), await read(after), labels)
}
