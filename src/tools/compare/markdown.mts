import type { ProblemSeverity } from '../../reports/evidence.mjs'
import {
  plural,
  type ChangeStatus,
  type Comparison,
  type ComparisonVerdict,
  type RunEvidence,
  type SideCount,
} from './types.mjs'

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

function changeTable({ labels, changes }: Omit<Comparison, 'markdown'>) {
  return [
    `| Problem | ${labels.before} | ${labels.after} | Change |`,
    '| --- | --- | --- | --- |',
    ...changes.map(
      (change) =>
        `| \`${change.code}\`${change.scope ? ` (${change.scope})` : ''}, ${SEVERITY_NAME[change.severity]} | ${describeSide(change.before)} | ${describeSide(change.after)} | ${CHANGE_NAME[change.status]} |`,
    ),
    '',
  ]
}

export function toMarkdown(comparison: Omit<Comparison, 'markdown'>): string {
  const { labels, changes, outcomes } = comparison
  const lines = [
    `**Recovery Probe: before and after**${comparison.mode ? ` · ${comparison.mode}` : ''}${comparison.target ? ` · \`${comparison.target}\`` : ''}`,
    '',
  ]
  if (changes.length) lines.push(...changeTable(comparison))
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
