import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** What happened to a problem between the two sides. */
export type ChangeStatus = 'GONE' | 'NEW' | 'STILL' | 'UNVERIFIED'

export type ComparisonVerdict =
  | 'IMPROVED'
  | 'PARTLY_IMPROVED'
  | 'REGRESSED'
  | 'MIXED'
  | 'UNCHANGED'
  | 'INCONCLUSIVE'
  | 'NOT_COMPARABLE'

/** A suspected defect or failed check, or a lead to review. */
export type ProblemSeverity = 'defect' | 'lead'

interface Problem {
  code: string
  /** The fault or scenario it was found under, when the report has several. */
  scope?: string
  severity: ProblemSeverity
}

/** What one report shows, reduced to what can be compared. */
export interface RunEvidence {
  path: string
  mode: string
  target?: string
  /** Whether the run finished well enough for a missing problem to count. */
  complete: boolean
  /** Why parts of the run do not count: errors, inconclusive rows, coverage gaps. */
  gaps: string[]
  problems: Problem[]
  /** Results that are not problems, such as RECOVERED or FEEDBACK_SHOWN. */
  outcomes: string[]
  /** Scopes the run checked to the end; '' stands for the whole check. */
  checked: string[]
  limitation?: string
}

interface SideCount {
  /** Runs that showed the problem. */
  found: number
  runs: number
  /** Complete runs that checked its scope: only these can show it is gone. */
  checked: number
}

export interface ProblemChange {
  code: string
  scope?: string
  severity: ProblemSeverity
  status: ChangeStatus
  before: SideCount
  after: SideCount
}

export interface Comparison {
  verdict: ComparisonVerdict
  summary: string
  /** 0: improved, or clean on both sides; 1: a new defect or failed check; 2: anything else to review. */
  exitCode: 0 | 1 | 2
  mode?: string
  target?: string
  labels: { before: string; after: string }
  before: RunEvidence[]
  after: RunEvidence[]
  changes: ProblemChange[]
  outcomes: { before: string[]; after: string[] }
  mismatch: string[]
  limitation?: string
  markdown: string
}

type Report = Record<string, unknown>
type Row = Record<string, unknown>

const OBSERVATION_MODES = new Set([
  'fault-free observation',
  'observation with network faults',
])
const FINDING_MODES = new Set([
  'experimental IPC discovery',
  'HTTP discovery',
  'IPC action check',
  'refresh experiment',
])
// Recovery checks with a row per fault: desktop, web, attached, guided and IPC
// checks are all named "... recovery".
const isCheck = (mode: string) =>
  mode.endsWith(' recovery') ||
  mode === 'configured recovery check' ||
  mode === 'controlled demonstration'

const list = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((item): item is Row => !!item && typeof item === 'object')
    : []
const string = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined
const scoped = (code: string, scope?: string) =>
  scope ? `${code} (${scope})` : code
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`

/** The first line of an error, enough to say why a run stopped. */
const briefly = (text: string) => text.split('\n')[0].slice(0, 160)

function targetOf(report: Report): string | undefined {
  const readiness = report.readiness as Record<string, unknown> | undefined
  const trigger = report.trigger as Record<string, unknown> | undefined
  const apps = list(report.apps)
  return (
    string(report.channel) ??
    string(report.endpoint) ??
    string(report.target) ??
    (Array.isArray(readiness?.relevantEndpoints)
      ? string(readiness.relevantEndpoints[0])
      : undefined) ??
    string(trigger?.name) ??
    (apps.length
      ? apps.map((app) => string(app.name) ?? '?').join(', ')
      : undefined)
  )
}

// Reports with a row per fault: pass, fail, inconclusive or skipped.
function fromCheck(report: Report, evidence: RunEvidence) {
  const baseline = report.baseline as Row | undefined
  if (baseline && baseline.outcome !== 'pass') {
    evidence.gaps.push(`baseline ${string(baseline.code) ?? 'did not pass'}`)
    evidence.complete = false
  }
  const rows = report.apps
    ? list(report.apps).flatMap((app) => list(app.results))
    : list(report.results)
  for (const row of rows) {
    const code = string(row.code) ?? 'UNKNOWN'
    const scope = string(row.kind) ?? string(row.fault) ?? string(row.scenario)
    if (row.outcome === 'fail') {
      evidence.problems.push({ code, scope, severity: 'defect' })
      if (scope) evidence.checked.push(scope)
    } else if (row.outcome === 'pass') {
      evidence.outcomes.push(scoped(code, scope))
      if (scope) evidence.checked.push(scope)
    } else evidence.gaps.push(scoped(code, scope))
  }
  if (!evidence.checked.length) evidence.complete = false
}

// Reports with findings classified as suspected-defect, decision-needed,
// observation (good outcomes such as RECOVERED) or inconclusive.
function fromFindings(report: Report, evidence: RunEvidence) {
  if (report.failedControl) {
    evidence.gaps.push('the control run failed')
    evidence.complete = false
  }
  let conclusive = 0
  for (const finding of list(report.findings)) {
    const code = string(finding.classification) ?? 'UNKNOWN'
    const scope = string(finding.fault)
    if (finding.kind === 'inconclusive' || finding.partial) {
      evidence.gaps.push(scoped(code, scope))
      continue
    }
    conclusive++
    if (scope) evidence.checked.push(scope)
    if (finding.kind === 'suspected-defect')
      evidence.problems.push({ code, scope, severity: 'defect' })
    else if (finding.kind === 'decision-needed')
      evidence.problems.push({ code, scope, severity: 'lead' })
    else evidence.outcomes.push(scoped(code, scope))
  }
  if (!conclusive) evidence.complete = false
}

// Observation findings are all leads; any coverage gap makes the run partial.
function fromObservation(report: Report, evidence: RunEvidence) {
  if (report.status !== 'complete' || report.captureComplete === false) {
    evidence.gaps.push(`capture ${string(report.status) ?? 'incomplete'}`)
    evidence.complete = false
  }
  const coverage = report.coverage as Record<string, unknown> | undefined
  for (const gap of Array.isArray(coverage?.gaps) ? coverage.gaps : []) {
    evidence.gaps.push(String(gap))
    evidence.complete = false
  }
  for (const finding of list(report.findings)) {
    const code = string(finding.code) ?? 'UNKNOWN'
    if (!evidence.problems.some((problem) => problem.code === code))
      evidence.problems.push({ code, severity: 'lead' })
  }
}

/**
 * The report files a path stands for: the file itself, the report.json in a
 * report folder, or those in the folders inside it (one folder per run).
 */
export async function reportFiles(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path]
  if (existsSync(join(path, 'report.json'))) return [join(path, 'report.json')]
  const runs = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name, 'report.json'))
    .filter((file) => existsSync(file))
    .sort()
  if (!runs.length)
    throw new Error(`No report.json in ${path} or in the folders inside it`)
  return runs
}

/** Reads one report file. */
export async function readRunEvidence(file: string): Promise<RunEvidence> {
  let report: Report
  try {
    report = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, {
      cause: error,
    })
  }
  return runEvidence(report, file)
}

/** Reduces a parsed report to what can be compared. */
export function runEvidence(report: Report, path = ''): RunEvidence {
  const mode = string(report?.mode)
  if (
    !mode ||
    !(OBSERVATION_MODES.has(mode) || FINDING_MODES.has(mode) || isCheck(mode))
  )
    throw new Error(
      `${path || 'This file'} is not a Recovery Probe report this version can compare${mode ? ` (mode: ${mode})` : ''}`,
    )
  const coverage = report.coverage as Record<string, unknown> | undefined
  const evidence: RunEvidence = {
    path,
    mode,
    target: targetOf(report),
    complete: true,
    gaps: [],
    problems: [],
    outcomes: [],
    checked: [],
    limitation: string(report.limitation) ?? string(coverage?.scope),
  }
  const error = string(report.error)
  if (error) {
    evidence.gaps.push(`error: ${briefly(error)}`)
    evidence.complete = false
  }
  if (OBSERVATION_MODES.has(mode)) fromObservation(report, evidence)
  else if (FINDING_MODES.has(mode)) fromFindings(report, evidence)
  else fromCheck(report, evidence)
  evidence.checked = evidence.complete
    ? [...new Set(['', ...evidence.checked])]
    : []
  return evidence
}

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

function mismatches(runs: RunEvidence[]): string[] {
  const modes = [...new Set(runs.map((run) => run.mode))]
  if (modes.length > 1) return [`different checks: ${modes.join(' and ')}`]
  const targets = [...new Set(runs.map((run) => run.target ?? 'none'))]
  return targets.length > 1
    ? [`different targets: ${targets.join(' and ')}`]
    : []
}

const codes = (changes: ProblemChange[]) =>
  changes.map((change) => scoped(change.code, change.scope)).join(', ')

function verdictOf(
  changes: ProblemChange[],
  before: RunEvidence[],
  after: RunEvidence[],
  mismatch: string[],
): Pick<Comparison, 'verdict' | 'summary' | 'exitCode'> {
  if (mismatch.length)
    return {
      verdict: 'NOT_COMPARABLE',
      summary: `These reports are not from the same check (${mismatch.join('; ')}). Run the same configuration on both sides.`,
      exitCode: 2,
    }
  const by = (status: ChangeStatus) =>
    changes.filter((change) => change.status === status)
  const gone = by('GONE')
  const added = by('NEW')
  const still = by('STILL')
  const unverified = by('UNVERIFIED')
  if (added.length)
    return {
      verdict: gone.length ? 'MIXED' : 'REGRESSED',
      summary: `${plural(added.length, 'new problem')} after the change (${codes(added)})${gone.length ? `, and ${plural(gone.length, 'problem')} gone (${codes(gone)})` : ''}.`,
      exitCode: added.some((change) => change.severity === 'defect') ? 1 : 2,
    }
  const left = [
    still.length ? `${still.length} still there (${codes(still)})` : '',
    unverified.length
      ? `${unverified.length} not checked to the end on the other side (${codes(unverified)})`
      : '',
  ].filter(Boolean)
  if (gone.length)
    return left.length
      ? {
          verdict: 'PARTLY_IMPROVED',
          summary: `${plural(gone.length, 'problem')} gone (${codes(gone)}); ${left.join('; ')}.`,
          exitCode: 2,
        }
      : {
          verdict: 'IMPROVED',
          summary: `${plural(gone.length, 'problem')} gone (${codes(gone)}), none new.`,
          exitCode: 0,
        }
  if (still.length)
    return {
      verdict: 'UNCHANGED',
      summary: `The change did not remove ${still.length === 1 ? 'the problem' : 'the problems'} it was checked for: ${left.join('; ')}.`,
      exitCode: 2,
    }
  const missing = [
    before.some((run) => run.complete)
      ? ''
      : 'no run before the change completed',
    after.some((run) => run.complete)
      ? ''
      : 'no run after the change completed',
    ...left,
  ].filter(Boolean)
  if (missing.length)
    return {
      verdict: 'INCONCLUSIVE',
      summary: `No side-by-side evidence: ${missing.join('; ')}.`,
      exitCode: 2,
    }
  return {
    verdict: 'UNCHANGED',
    summary:
      'Neither side showed a problem. That shows no regression, but it is no evidence of a fix: the runs before the change did not reproduce one.',
    exitCode: 0,
  }
}

const VERDICT_NAME: Record<ComparisonVerdict, string> = {
  IMPROVED: 'Improved',
  PARTLY_IMPROVED: 'Partly improved',
  REGRESSED: 'Regressed',
  MIXED: 'Mixed',
  UNCHANGED: 'Unchanged',
  INCONCLUSIVE: 'Inconclusive',
  NOT_COMPARABLE: 'Not comparable',
}
const CHANGE_NAME: Record<ChangeStatus, string> = {
  GONE: 'gone',
  NEW: 'new',
  STILL: 'still there',
  UNVERIFIED: 'not checked to the end',
}
const SEVERITY_NAME: Record<ProblemSeverity, string> = {
  defect: 'suspected defect',
  lead: 'lead',
}

/** How one side looks for a problem, such as "3 of 3 runs" or "none in 2 complete runs". */
export function describeSide(count: SideCount): string {
  if (count.found) return `${count.found} of ${plural(count.runs, 'run')}`
  if (count.checked) return `none in ${plural(count.checked, 'complete run')}`
  return 'not checked'
}

export function describeRuns(runs: RunEvidence[]): string {
  const complete = runs.filter((run) => run.complete).length
  return `${plural(runs.length, 'run')}, ${complete} complete`
}

const quoted = (items: string[]) =>
  items.map((item) => `\`${item}\``).join(', ') || 'none'

function toMarkdown(comparison: Omit<Comparison, 'markdown'>): string {
  const { labels, changes, outcomes } = comparison
  const lines = [
    `**Recovery Probe: before and after**${comparison.mode ? ` · ${comparison.mode}` : ''}${comparison.target ? ` · \`${comparison.target}\`` : ''}`,
    '',
  ]
  if (changes.length)
    lines.push(
      `| Problem | ${labels.before} | ${labels.after} | Change |`,
      '| --- | --- | --- | --- |',
      ...changes.map(
        (change) =>
          `| \`${change.code}\`${change.scope ? ` (${change.scope})` : ''}, ${SEVERITY_NAME[change.severity]} | ${describeSide(change.before)} | ${describeSide(change.after)} | ${CHANGE_NAME[change.status]} |`,
      ),
      '',
    )
  else if (comparison.verdict !== 'NOT_COMPARABLE')
    lines.push('No problem on either side.', '')
  if (outcomes.before.length || outcomes.after.length)
    lines.push(
      `Other outcomes: ${labels.before} ${quoted(outcomes.before)}; ${labels.after} ${quoted(outcomes.after)}.`,
      '',
    )
  lines.push(
    `Runs: ${labels.before} ${describeRuns(comparison.before)}; ${labels.after} ${describeRuns(comparison.after)}.`,
    '',
    `**${VERDICT_NAME[comparison.verdict]}:** ${comparison.summary}`,
  )
  if (comparison.limitation)
    lines.push('', `Covers only this check. ${comparison.limitation}`)
  return `${lines.join('\n')}\n`
}

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
  const problems = new Map<string, Problem>()
  for (const run of [...before, ...after])
    for (const problem of run.problems)
      if (!problems.has(keyOf(problem))) problems.set(keyOf(problem), problem)
  const order: ChangeStatus[] = ['NEW', 'STILL', 'GONE', 'UNVERIFIED']
  const changes: ProblemChange[] = [...problems.values()]
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
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
  const outcomesOf = (runs: RunEvidence[]) => [
    ...new Set(runs.flatMap((run) => run.outcomes)),
  ]
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
