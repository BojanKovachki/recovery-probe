/** The version of the rules below; reports name it so a reader knows which applied. */
export const VERDICT_RULES = 'recovery-probe/verdict-rules@1'

export type ClaimOutcome = 'VERIFIED' | 'FAILED' | 'NOT_VERIFIED'

/** What happened to a claim's work, apart from what its evidence says. */
export type ExecutionStatus =
  | 'completed'
  | 'failed-to-start'
  | 'timed-out'
  | 'cancelled'
  | 'budget-exhausted'
  | 'skipped'
  | 'unavailable'

/** The candidate changed the criteria the claim is judged by. */
export type CriteriaChange =
  | 'POLICY_CHANGED'
  | 'EXPECTATION_CHANGED'
  | 'CHECK_INPUT_CHANGED'
  | 'TEST_CHANGED'

/** What the rules decide one claim from. */
export interface ClaimFacts {
  /** Whether the claim has an expectation to judge it by, or how the candidate changed it. */
  expectation: 'present' | 'missing' | CriteriaChange
  /**
   * Whether the candidate ran the approved criteria, not its changed ones. A new failure they
   * show is established even when the candidate changed the criteria.
   */
  approvedCriteriaRan?: boolean
  /**
   * The candidate's attempts: whether each ran to the end, whether it saw a failure, and which
   * of the claim's scenarios it ran when there are several.
   */
  attempts: { completed: boolean; failed: boolean; scenario?: string }[]
  execution: ExecutionStatus
  /** Why the evidence is incomplete, as codes; the first one becomes the reason. */
  incomplete: string[]
  /** The comparison's reason when the candidate failed, such as NEW_FAILURE. */
  failure: string
}

export interface Decision {
  outcome: ClaimOutcome
  reason: string
}

const notVerified = (reason: string): Decision => ({
  outcome: 'NOT_VERIFIED',
  reason,
})

/** What an observed failure decides, if an attempt saw one: UNSTABLE, or FAILED. */
function failureOf(facts: ClaimFacts): Decision | undefined {
  // A failure counts from any attempt, even one that stopped early.
  const failed = facts.attempts.filter((attempt) => attempt.failed)
  if (!failed.length) return undefined
  // Only a pass of the same scenario makes a failure unstable.
  return failed.some((failure) =>
    facts.attempts.some(
      (attempt) =>
        attempt.scenario === failure.scenario &&
        attempt.completed &&
        !attempt.failed,
    ),
  )
    ? notVerified('UNSTABLE')
    : { outcome: 'FAILED', reason: facts.failure }
}

/** The first rule that applies decides; see docs/architecture/verifier-design.md. */
export function decideClaim(facts: ClaimFacts): Decision {
  if (facts.expectation === 'missing') return notVerified('EXPECTATION_MISSING')
  const failure = failureOf(facts)
  if (facts.expectation !== 'present')
    return facts.approvedCriteriaRan &&
      failure?.outcome === 'FAILED' &&
      failure.reason === 'NEW_FAILURE'
      ? failure
      : notVerified(facts.expectation)
  if (failure) return failure
  if (facts.execution !== 'completed')
    return notVerified(facts.execution.toUpperCase().replaceAll('-', '_'))
  if (facts.incomplete.length) return notVerified(facts.incomplete[0])
  if (!facts.attempts.length) return notVerified('NOT_RUN')
  return { outcome: 'VERIFIED', reason: 'PASSED' }
}

/** What decides a policy run as a whole. */
export interface RunFacts {
  claims: Decision[]
  policyRecorded: boolean
  /** Gaps that concern the whole run, such as BASE_NOT_ON_REMOTE. */
  runGaps: string[]
  /** Changed files no claim covers, outside the base's ignore rules. */
  uncovered: string[]
  /** Test files the candidate changed or deleted: they need approval, whichever claims they affect. */
  changedTests: string[]
}

/**
 * Exit 1 for an established new failure, even when other claims are incomplete; 0 when
 * every claim is verified and nothing blocks the verdict; 2 otherwise.
 */
export function decideRun(facts: RunFacts): {
  verdict: 'VERIFIED' | 'NOT_VERIFIED'
  exitCode: 0 | 1 | 2
} {
  const verified =
    facts.claims.length > 0 &&
    facts.claims.every((claim) => claim.outcome === 'VERIFIED') &&
    facts.policyRecorded &&
    !facts.runGaps.length &&
    !facts.uncovered.length &&
    !facts.changedTests.length
  const regressed = facts.claims.some(
    (claim) => claim.outcome === 'FAILED' && claim.reason === 'NEW_FAILURE',
  )
  return {
    verdict: verified ? 'VERIFIED' : 'NOT_VERIFIED',
    exitCode: regressed ? 1 : verified ? 0 : 2,
  }
}
