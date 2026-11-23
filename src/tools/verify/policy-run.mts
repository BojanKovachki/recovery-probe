import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RunBudget } from '../../core/budget.mjs'
import { changesSince, commitOf, PlanInputError } from '../plan/changes.mjs'
import { checkOutSides, type Checkouts } from './checkout.mjs'
import { DEFAULT_REGISTRY } from '../plan/registry.mjs'
import {
  registryAt,
  repoPathOf,
  sha256,
  type Registries,
  type Sides,
} from './criteria.mjs'
import {
  baseGaps,
  baseProvenance,
  blobAt,
  revisionsOf,
  snapshotCommit,
} from './git.mjs'
import { pendingSuspectClaim, suspectClaim } from './plan-claims.mjs'
import {
  behaviorClaim,
  behaviorStatement,
  projectStatement,
  type PolicyContext,
  type PolicyOptions,
} from './policy-claims.mjs'
import { environmentOf, projectClaim } from './project-checks.mjs'
import { validatePolicy, type Policy } from './policy.mjs'
import { VerificationLog, type PendingClaim } from './record.mjs'
import { decideRun } from './rules.mjs'
import { folderOf } from './side.mjs'
import { coverageOf, testChanges } from './changed-files.mjs'
import {
  finishVerification,
  reasonOf,
  scanChangedLines,
  summarizedEvenIfStopped,
  type Verification,
} from './summary.mjs'
import type { Claim, Expectation, PolicyIdentity } from './types.mjs'

export type { PolicyOptions } from './policy-claims.mjs'

// Verify always scans the changed lines; the policy can't turn it off.
const SCAN: Expectation = { source: 'policy', approved: true }
const UNDECIDED: Expectation = { source: 'policy', approved: false }

/** The repository, the base commit the invocation names, and a snapshot of the working tree. */
async function sidesOf(options: PolicyOptions) {
  const cwd = process.cwd()
  const { root, revisions } = await revisionsOf(cwd, options.base)
  if (!root)
    throw new PlanInputError(
      'Policy mode reads its criteria from Git: run verify inside the repository',
    )
  const base = revisions.base.commit ?? (await commitOf(root, options.base))
  const candidate = revisions.candidate.snapshotTree
  if (!candidate) throw new Error("Git couldn't snapshot the working tree")
  const commit = await snapshotCommit(root, candidate, revisions.candidate.head)
  revisions.candidate.snapshotCommit = commit
  return {
    sides: { root, cwd, base, candidate } as Sides,
    revisions,
    commits: { base, candidate: commit },
  }
}

/** The longest the claims can take: each run at its cap, each launch at its readiness limit. */
const worstCaseOf = (policy: Policy) =>
  policy.claims.reduce((sum, claim) => {
    const runs = 2 * policy.runs * policy.budgets.scenarioRunMs
    const app = claim.app && policy.apps[claim.app]
    return sum + (app ? 2 * (app.ready.timeoutMs + runs) : runs)
  }, 0)

/** The base's policy and its identity, or why there's no usable one. */
async function policyAt(sides: Sides, path: string) {
  const bytes = await blobAt(sides.root, sides.base, path)
  if (!bytes)
    return { gap: `POLICY_NOT_ON_BASE: ${path} isn't committed on the base` }
  const candidate = await blobAt(sides.root, sides.candidate, path)
  const identity: PolicyIdentity = {
    path,
    source: 'base',
    commit: sides.base,
    sha256: sha256(bytes),
    changedInCandidate: !candidate || sha256(candidate) !== sha256(bytes),
  }
  try {
    const policy = validatePolicy(JSON.parse(bytes.toString('utf8')))
    return { identity, policy }
  } catch (error) {
    return { identity, gap: `POLICY_INVALID: ${(error as Error).message}` }
  }
}

const pendingOf = (
  policy: Policy | undefined,
  base: string,
  registries: Registries,
): PendingClaim[] => [
  ...(policy?.projectChecks ?? []).map((check) => ({
    id: `project/${check.id}`,
    kind: 'project-check' as const,
    statement: projectStatement(check),
    expectation: UNDECIDED,
  })),
  ...(policy?.claims ?? []).map((claim) => ({
    id: `behavior/${claim.id}`,
    kind: 'behavior' as const,
    statement: behaviorStatement(claim, registries),
    expectation: UNDECIDED,
  })),
  pendingSuspectClaim(base, SCAN),
]

/** What blocks VERIFIED whatever the claims say: files no claim covers, and changed tests. */
interface Blocking {
  uncovered: string[]
  changedTests: string[]
}

/** One reason per unverified claim, run-level gap, and what else blocks the run. */
const reasonsOf = (
  claims: Claim[],
  runGaps: string[],
  { uncovered, changedTests }: Blocking,
) => [
  ...claims
    .filter((claim) => claim.outcome !== 'VERIFIED')
    .map((claim) => `${claim.id}: ${reasonOf(claim)}`),
  ...runGaps,
  ...(uncovered.length
    ? [
        `${uncovered.length} changed file(s) no claim covers: ${uncovered.join(', ')}`,
      ]
    : []),
  ...(changedTests.length
    ? [
        `${changedTests.length} test file(s) changed or deleted, which a person must approve on the base: ${changedTests.join(', ')}`,
      ]
    : []),
]

type DecideContext = Omit<PolicyContext, 'policy' | 'identity' | 'tests'> &
  Partial<Pick<PolicyContext, 'policy' | 'identity'>>

/**
 * The policy's claims in order, each recorded once decided, the change's coverage and what it
 * did to tests. None without a usable policy.
 */
async function policyClaims(context: DecideContext) {
  const { sides, policy, identity, registries } = context
  if (!policy || !identity)
    return {
      claims: [] as Claim[],
      coverage: { uncovered: [], ignored: [] },
      tests: undefined,
    }
  const { changes } = await changesSince(sides.base, { cwd: sides.root })
  const tests = await testChanges(sides, changes, policy.testFiles)
  const full = { ...context, policy, identity, tests }
  const claims: Claim[] = []
  for (const next of [
    ...policy.projectChecks.map((check) => () => projectClaim(full, check)),
    ...policy.claims.map((claim) => () => behaviorClaim(full, claim)),
  ]) {
    const claim = await next()
    claims.push(claim)
    await context.log.decided(claim)
  }
  return { claims, coverage: coverageOf(policy, registries, changes), tests }
}

/** Decides the scan, every claim, then the run. Without a usable policy, only the scan runs. */
async function decide(
  context: DecideContext,
  runGaps: string[],
): Promise<Verification> {
  const { options, sides, directory, log, policy, identity, budget } = context
  options.onEvent?.({ type: 'scanning', base: options.base })
  const scan = await scanChangedLines(sides.base)
  if (policy)
    options.onEvent?.({
      type: 'planned',
      worstCaseMs: worstCaseOf(policy),
      budgetMs: budget.maxDurationMs,
    })
  const { claims, coverage, tests } = await policyClaims(context)
  claims.push(suspectClaim(options.base, scan, SCAN))
  const stoppedByBudget = claims.some(
    (claim) => claim.execution.status === 'budget-exhausted',
  )
  const blocking = {
    uncovered: coverage.uncovered,
    changedTests: tests?.changed ?? [],
  }
  const { verdict, exitCode } = decideRun({
    claims,
    policyRecorded: Boolean(identity),
    runGaps,
    ...blocking,
  })
  const fields = {
    verdict,
    exitCode,
    reasons: reasonsOf(claims, runGaps, blocking),
    checks: [],
    suspects: scan.suspects,
    directory,
  }
  return finishVerification(log, fields, {
    status: stoppedByBudget ? 'budget-exhausted' : 'completed',
    claims,
    coverage,
    ...(tests ? { reviewSignals: tests.signals } : {}),
    environment: await environmentOf(sides, policy?.env ?? []),
  })
}

/** The policy's overall budget, which an override can only lower, counted from `started`. */
const budgetOf = (
  policy: Policy | undefined,
  budgetMs: number | undefined,
  started: number,
) =>
  new RunBudget(
    Math.min(policy?.budgets.totalMs ?? Infinity, budgetMs ?? Infinity),
    policy?.budgets.cleanupReserveMs ?? 0,
    started,
  )

/** The registry as committed on the base and as the candidate has it. */
async function registriesOf(sides: Sides): Promise<Registries> {
  const path = repoPathOf(sides, DEFAULT_REGISTRY)
  return {
    path,
    base: await registryAt(sides, sides.base, path),
    candidate: await registryAt(sides, sides.candidate, path),
  }
}

/**
 * Verifies a change against the policy committed on `base`: its claims, judged by the base's
 * criteria, the candidate's changes to them, coverage of the changed files and the suspect
 * scan. Experimental; see docs/verify.md.
 */
export async function verifyPolicy(
  options: PolicyOptions,
): Promise<Verification> {
  // The budget counts everything, the snapshot and checkouts included.
  const started = performance.now()
  const { sides, revisions, commits } = await sidesOf(options)
  const directory = folderOf(options)
  await rm(join(directory, 'policy'), { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  const registries = await registriesOf(sides)
  const read = await policyAt(sides, repoPathOf(sides, options.policy))
  const provenance = await baseProvenance(sides.root, options.base, sides.base)
  const runGaps = [...baseGaps(provenance), ...(read.gap ? [read.gap] : [])]
  const log = await VerificationLog.start(
    directory,
    {
      mode: 'policy',
      revisions,
      baseProvenance: provenance,
      ...(read.identity ? { policy: read.identity } : {}),
      runGaps,
    },
    pendingOf(read.policy, options.base, registries),
  )
  const { policy, identity } = read
  const budget = budgetOf(policy, options.budgetMs, started)
  let checkouts: Promise<Checkouts> | undefined
  const context = {
    options,
    sides,
    directory,
    log,
    registries,
    policy,
    identity,
    budget,
    checkouts: () => (checkouts ??= checkOutSides(sides.root, commits)),
    setups: new Map(),
  }
  try {
    return await summarizedEvenIfStopped(log, options.signal, () =>
      decide(context, runGaps),
    )
  } finally {
    await checkouts?.then((made) => made.remove()).catch(() => {})
  }
}
