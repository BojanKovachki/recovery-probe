import type { StopReason } from '../process.mjs'
import type { ClaimOutcome, CriteriaChange, ExecutionStatus } from './rules.mjs'

/** Marks summary.json and verification.partial.json; readers of the older fields can ignore it. */
export const VERIFICATION_SCHEMA = 'recovery-probe/verification@1'

export type ClaimKind = 'project-check' | 'behavior' | 'suspect-scan'

/** Where a claim's criteria come from, and whether they're approved. */
export interface Expectation {
  /** `policy`: approved on the base; `plan`: the plan file, which nobody approves. */
  source: 'policy' | 'plan'
  approved: boolean
  /** `sha256:` over the claim's definition and the committed bytes of every file it reads. */
  approvedVersion?: string
  candidateVersion?: string
  /** What the candidate changed: files, or definitions such as `registry#items`. */
  changedInputs?: string[]
}

export interface ClaimAttempt {
  side: 'base' | 'candidate'
  /** Which run of the claim, from 1. */
  n: number
  /** The scenario a behavior claim ran: its failure or normal path. */
  path?: 'failure' | 'normal'
  exitCode?: number | null
  stopped?: StopReason
  /** Relative to the run folder. */
  report?: string
  log?: string
  /** The criteria the attempt ran with: the approved ones, even when the candidate changed them. */
  against?: 'approvedVersion'
}

export interface Claim {
  /** Stable: `behavior/<name>`, `project/<id>` or `suspects/changed-lines`. */
  id: string
  kind: ClaimKind
  statement: string
  expectation: Expectation
  outcome: ClaimOutcome
  /** One code for the outcome, such as NEW_FAILURE or EXPECTATION_CHANGED. */
  reason: string
  /** How the candidate changed the claim's criteria: a person must approve that on the base, whatever the outcome. */
  criteriaChange?: CriteriaChange
  execution: { status: ExecutionStatus; attempts: ClaimAttempt[] }
  baseline: { status: string; comparison?: string }
  /** Report files the claim's outcome rests on, relative to the run folder, with their hashes. */
  evidence: { path: string; sha256: string }[]
  /** What the claim doesn't cover or couldn't check. */
  gaps: string[]
}

export interface Revisions {
  base: { ref: string; commit: string | null }
  candidate: {
    head: string | null
    /** The tree Git would commit for the working tree, ignored files left out. */
    snapshotTree: string | null
    uncommittedChanges: boolean | null
    /** In policy mode: the commit of that tree the candidate side is checked out from. */
    snapshotCommit?: string
  }
}

/** Where the base came from, and what can and can't be said about it. */
export interface BaseProvenance {
  ref: string
  commit: string
  suppliedBy: 'ci' | 'local'
  /** Whether the base is on the remote branch of the same name; never proof of review. */
  onRemoteTracking: {
    ref: string | null
    result: 'equal' | 'ancestor' | 'not-on-remote' | 'no-remote-branch'
  }
  note: string
}

export interface PolicyIdentity {
  path: string
  source: 'base'
  commit: string
  sha256: string
  changedInCandidate: boolean
}

export interface RunRecord {
  id: string
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'budget-exhausted'
  startedAt: string
  endedAt?: string
}

/** What verify adds to its older fields, in summary.json and verification.partial.json. */
export interface VerificationRecord {
  schema: typeof VERIFICATION_SCHEMA
  mode: 'plan' | 'policy'
  run: RunRecord
  revisions: Revisions
  verdictRules: string
  claims: Claim[]
  baseProvenance?: BaseProvenance
  policy?: PolicyIdentity
  coverage?: { uncovered: string[]; ignored: string[] }
  /** What commands ran with: Node, the platform, the variable names passed, and each side's lockfiles. */
  environment?: {
    node: string
    platform: string
    envNames: string[]
    lockfiles: Record<'base' | 'candidate', Record<string, string>>
  }
  /** Gaps that concern the whole run, such as BASE_NOT_ON_REMOTE. */
  runGaps?: string[]
}
