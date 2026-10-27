import type { Evidence, ProblemSeverity } from '../../reports/evidence.mjs'

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

/** One report's evidence, with where it came from. */
export interface RunEvidence extends Omit<Evidence, 'schema'> {
  path: string
  /** The report's own label for what it ran, for display. */
  mode: string
  limitation?: string
}

export interface SideCount {
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

export const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`
