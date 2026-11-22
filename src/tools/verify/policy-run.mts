import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { changesSince, commitOf, PlanInputError } from '../plan/changes.mjs'
import { safeRelativePath } from '../plan/paths.mjs'
import { DEFAULT_REGISTRY } from '../plan/registry.mjs'
import { globRegExp, selections } from '../plan/select.mjs'
import {
  registryAt,
  repoPathOf,
  sha256,
  type Registries,
  type Sides,
} from './criteria.mjs'
import { baseGaps, baseProvenance, blobAt, revisionsOf } from './git.mjs'
import { pendingSuspectClaim, suspectClaim } from './plan-claims.mjs'
import {
  behaviorClaim,
  behaviorStatement,
  projectClaim,
  projectStatement,
  type PolicyContext,
  type PolicyOptions,
} from './policy-claims.mjs'
import { validatePolicy, type Policy } from './policy.mjs'
import { VerificationLog, type PendingClaim } from './record.mjs'
import { decideRun } from './rules.mjs'
import { folderOf } from './side.mjs'
import {
  finishVerification,
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
  return { sides: { root, cwd, base, candidate } as Sides, revisions }
}

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

/** Changed files the base's ignore rules leave out, and those no claim's scenarios cover. */
async function coverageOf({ sides, policy, registries }: PolicyContext) {
  const { changes } = await changesSince(sides.base, { cwd: sides.root })
  const rules = policy.ignore.map(globRegExp)
  const ignored = changes.filter((change) =>
    rules.some((rule) => rule.test(change.path)),
  )
  const rest = changes.filter((change) => !ignored.includes(change))
  const entries = policy.claims
    .flatMap((claim) => [claim.failurePath, claim.normalPath])
    .map((name) => {
      const paths = registries.base.get(name)?.paths
      return {
        name,
        paths: (Array.isArray(paths) ? paths : []).filter(
          (path): path is string =>
            typeof path === 'string' && Boolean(safeRelativePath(path)),
        ),
      }
    })
  const covered = new Set(selections(rest, entries).map((found) => found.file))
  return {
    uncovered: rest
      .map((change) => change.path)
      .filter((path) => !covered.has(path)),
    ignored: ignored.map((change) => change.path),
  }
}

/** One reason per unverified claim, run-level gap, and the uncovered files. */
const reasonsOf = (claims: Claim[], runGaps: string[], uncovered: string[]) => [
  ...claims
    .filter((claim) => claim.outcome !== 'VERIFIED')
    .map((claim) => `${claim.id}: ${claim.reason}`),
  ...runGaps,
  ...(uncovered.length
    ? [
        `${uncovered.length} changed file(s) no claim covers: ${uncovered.join(', ')}`,
      ]
    : []),
]

type DecideContext = Omit<PolicyContext, 'policy' | 'identity'> &
  Partial<Pick<PolicyContext, 'policy' | 'identity'>>

/** The policy's claims in order, each recorded once decided, and the change's coverage. */
async function policyClaims(context: PolicyContext) {
  const claims: Claim[] = []
  for (const next of [
    ...context.policy.projectChecks.map(
      (check) => () => projectClaim(context, check),
    ),
    ...context.policy.claims.map(
      (claim) => () => behaviorClaim(context, claim),
    ),
  ]) {
    const claim = await next()
    claims.push(claim)
    await context.log.decided(claim)
  }
  return { claims, coverage: await coverageOf(context) }
}

/** Decides every claim, then the run. Without a usable policy, only the scan runs. */
async function decide(
  context: DecideContext,
  runGaps: string[],
): Promise<Verification> {
  const { options, sides, directory, log, policy, identity } = context
  const { claims, coverage } =
    policy && identity
      ? await policyClaims({ ...context, policy, identity })
      : { claims: [], coverage: { uncovered: [], ignored: [] } }
  options.onEvent?.({ type: 'scanning', base: options.base })
  const scan = await scanChangedLines(sides.base)
  claims.push(suspectClaim(options.base, scan, SCAN))
  const { verdict, exitCode } = decideRun({
    claims,
    policyRecorded: Boolean(identity),
    runGaps,
    uncovered: coverage.uncovered,
  })
  const fields = {
    verdict,
    exitCode,
    reasons: reasonsOf(claims, runGaps, coverage.uncovered),
    checks: [],
    suspects: scan.suspects,
    directory,
  }
  return finishVerification(log, fields, {
    status: 'completed',
    claims,
    coverage,
  })
}

/**
 * Verifies a change against the policy committed on `base`: its claims, judged by the base's
 * criteria, the candidate's changes to them, coverage of the changed files and the suspect
 * scan. Experimental; see docs/verify.md.
 */
export async function verifyPolicy(
  options: PolicyOptions,
): Promise<Verification> {
  const { sides, revisions } = await sidesOf(options)
  const directory = folderOf(options)
  await rm(join(directory, 'policy'), { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  const path = repoPathOf(sides, DEFAULT_REGISTRY)
  const registries: Registries = {
    path,
    base: await registryAt(sides, sides.base, path),
    candidate: await registryAt(sides, sides.candidate, path),
  }
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
  const context = {
    options,
    sides,
    directory,
    log,
    registries,
    policy,
    identity,
  }
  return summarizedEvenIfStopped(log, options.signal, () =>
    decide(context, runGaps),
  )
}
