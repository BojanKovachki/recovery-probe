import { scoped } from '../../reports/evidence.mjs'
import {
  plural,
  type ChangeStatus,
  type Comparison,
  type ProblemChange,
  type RunEvidence,
} from './types.mjs'

type Verdict = Pick<Comparison, 'verdict' | 'summary' | 'exitCode'>

const codes = (changes: ProblemChange[]) =>
  changes.map((change) => scoped(change.code, change.scope)).join(', ')

const regressed = (added: ProblemChange[], gone: ProblemChange[]): Verdict => ({
  verdict: gone.length ? 'MIXED' : 'REGRESSED',
  summary: `${plural(added.length, 'new problem')} after the change (${codes(added)})${gone.length ? `, and ${plural(gone.length, 'problem')} gone (${codes(gone)})` : ''}.`,
  exitCode: added.some((change) => change.severity === 'defect') ? 1 : 2,
})

const improved = (gone: ProblemChange[], left: string[]): Verdict =>
  left.length
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

/** No problem left or gone: either nothing to compare, or nothing found on either side. */
function withoutProblems(
  before: RunEvidence[],
  after: RunEvidence[],
  left: string[],
): Verdict {
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

export function verdictOf(
  changes: ProblemChange[],
  before: RunEvidence[],
  after: RunEvidence[],
  mismatch: string[],
): Verdict {
  if (mismatch.length)
    return {
      verdict: 'NOT_COMPARABLE',
      summary: `These reports are not from the same check (${mismatch.join('; ')}). Run the same configuration on both sides.`,
      exitCode: 2,
    }
  const by = (status: ChangeStatus) =>
    changes.filter((change) => change.status === status)
  const [gone, added, still, unverified] = [
    by('GONE'),
    by('NEW'),
    by('STILL'),
    by('UNVERIFIED'),
  ]
  if (added.length) return regressed(added, gone)
  const left = [
    still.length ? `${still.length} still there (${codes(still)})` : '',
    unverified.length
      ? `${unverified.length} not checked to the end on the other side (${codes(unverified)})`
      : '',
  ].filter(Boolean)
  if (gone.length) return improved(gone, left)
  if (still.length)
    return {
      verdict: 'UNCHANGED',
      summary: `The change did not remove ${still.length === 1 ? 'the problem' : 'the problems'} it was checked for: ${left.join('; ')}.`,
      exitCode: 2,
    }
  return withoutProblems(before, after, left)
}
