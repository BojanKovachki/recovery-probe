import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareReports } from '../compare/run.mjs'
import { scanForSuspects } from '../suspects/scan.mjs'
import {
  recordBaseline,
  verifyChange,
  verifyPlan,
  verifyPolicy,
  type Verification,
} from '../verify.mjs'
import { PARTIAL_SUMMARY } from '../verify/record.mjs'
import { text } from './args.mjs'
import type { McpTool } from './server.mjs'

const MAX_SUSPECTS = 200

export const findSuspectsTool: McpTool = {
  name: 'find_suspects',
  title: 'Find failure handling that can lose data',
  description:
    'Reads JavaScript and TypeScript sources, without running them, for two patterns: UNKNOWN_AS_EMPTY (a failed or unexpected read becomes an empty collection, so "unknown" looks like "none") and FAILURE_ONLY_LOGGED (a read stores its data when it succeeds, but its failure is only logged). Each suspect names the read to fail and the check that proves or dismisses it. Use changedSince "main" to scan only what a branch changed. Needs TypeScript in the project.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Files and directories to scan, relative to the working directory. Default: all of it.',
      },
      changedSince: {
        type: 'string',
        description:
          'Git reference, such as main: scan only the files changed since it, uncommitted and untracked ones included.',
      },
      includeTests: {
        type: 'boolean',
        default: false,
        description: 'Scan test files too.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args) {
    const paths = args.paths ?? []
    if (
      !Array.isArray(paths) ||
      paths.some((path) => typeof path !== 'string' || !path.trim())
    )
      throw new Error('paths must be a list of non-empty strings')
    if (
      args.includeTests !== undefined &&
      typeof args.includeTests !== 'boolean'
    )
      throw new Error('includeTests must be true or false')
    const { scanned, suspects } = await scanForSuspects({
      paths,
      changedSince: text(args, 'changedSince', false),
      includeTests: args.includeTests === true,
    })
    return {
      scanned,
      found: suspects.length,
      suspects: suspects.slice(0, MAX_SUSPECTS),
      ...(suspects.length > MAX_SUSPECTS
        ? { omitted: suspects.length - MAX_SUSPECTS }
        : {}),
    }
  },
}

const reportPaths = (args: Record<string, unknown>, key: string) => {
  const paths = args[key]
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some((path) => typeof path !== 'string' || !path.trim())
  )
    throw new Error(`${key} must be a non-empty list of report paths`)
  return paths as string[]
}

export const compareReportsTool: McpTool = {
  name: 'compare_reports',
  title: 'Compare reports from before and after a change',
  description:
    'Compares reports of the same check from before and after a change, such as main and a branch, and returns a verdict (IMPROVED, PARTLY_IMPROVED, REGRESSED, MIXED, UNCHANGED, INCONCLUSIVE or NOT_COMPARABLE), what happened to each problem, and a Markdown block for a pull request. A problem counts as gone only when a complete run after the change checked it, so a run that stopped early is never a fix. Give several reports per side for repeated runs.',
  inputSchema: {
    type: 'object',
    properties: {
      before: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'Reports from before the change: report.json files or their folders.',
      },
      after: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Reports of the same check from after the change.',
      },
      beforeLabel: {
        type: 'string',
        description: 'Name for the before side, such as main.',
      },
      afterLabel: {
        type: 'string',
        description: 'Name for the after side, such as the branch.',
      },
    },
    required: ['before', 'after'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (args) =>
    compareReports(reportPaths(args, 'before'), reportPaths(args, 'after'), {
      before: text(args, 'beforeLabel', false),
      after: text(args, 'afterLabel', false),
    }),
}

const VERIFY_FOLDER = join('.recovery-probe', 'verify')

const claimsOf = (claims: { id: string; outcome: string; reason: string }[]) =>
  claims.map(({ id, outcome, reason }) => ({ id, outcome, reason }))

/** What verify_change returns from a finished verification. */
const resultOf = (result: Verification) => ({
  verdict: result.verdict,
  reasons: result.reasons,
  checks: result.checks.map(({ name, verified, reason, comparison }) => ({
    name,
    verified,
    ...(reason ? { reason } : {}),
    ...(comparison ? { comparison: comparison.verdict } : {}),
  })),
  claims: claimsOf(result.claims),
  suspects: result.suspects.slice(0, MAX_SUSPECTS),
  markdown: result.markdown,
})

/** The last verification here: a run in progress or stopped, else the last summary. */
async function lastVerification() {
  for (const [source, file] of [
    ['partial', PARTIAL_SUMMARY],
    ['summary', 'summary.json'],
  ] as const) {
    const text = await readFile(join(VERIFY_FOLDER, file), 'utf8').catch(
      () => null,
    )
    if (text === null) continue
    const {
      verdict,
      exitCode,
      reasons,
      run,
      claims = [],
      runGaps,
    } = JSON.parse(text)
    return {
      source,
      ...(verdict ? { verdict, exitCode, reasons } : {}),
      run,
      claims: claimsOf(claims),
      ...(runGaps ? { runGaps } : {}),
    }
  }
  throw new Error(`No verification has run here yet: ${VERIFY_FOLDER} is empty`)
}

/** Arguments that don't go together, each with what to do about it. */
const CONFLICTS: [(args: Record<string, unknown>) => unknown, string][] = [
  [
    (a) => a.status && (a.baseline || a.policy || a.plan),
    'status runs nothing: leave out the other arguments',
  ],
  [
    (a) => a.policy && !a.base,
    'policy needs base: the Git reference the change starts from, such as main',
  ],
  [
    (a) => !a.policy && a.base,
    'base goes with policy; a plan names its own base',
  ],
  [
    (a) => a.policy && (a.baseline || a.plan),
    'policy replaces the plan and its recorded baseline: leave out plan and baseline',
  ],
]

/** The flags that select what verify_change does, or the first one given wrongly. */
function modeOf(args: Record<string, unknown>) {
  for (const key of ['baseline', 'status'])
    if (args[key] !== undefined && typeof args[key] !== 'boolean')
      throw new Error(`${key} must be true or false`)
  const policy = text(args, 'policy', false)
  const base = text(args, 'base', false)
  const conflict = CONFLICTS.find(([applies]) =>
    applies({ ...args, policy, base }),
  )
  if (conflict) throw new Error(conflict[1])
  return { policy, base, status: args.status === true }
}

async function recordPlanBaseline(
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runs = await recordBaseline({ plan: await planOf(args), signal })
  return {
    baseline: 'recorded',
    runs: Object.fromEntries(
      [...runs].map(([name, results]) => [
        name,
        results.map((run) =>
          run.evidence
            ? { complete: run.evidence.complete }
            : { error: run.error },
        ),
      ]),
    ),
  }
}

const planOf = async (args: Record<string, unknown>) =>
  verifyPlan(
    JSON.parse(
      await readFile(
        text(args, 'plan', false) ?? join('.recovery-probe', 'verify.json'),
        'utf8',
      ),
    ),
  )

export const verifyChangeTool: McpTool = {
  name: 'verify_change',
  title: 'Verify a code change with before and after evidence',
  description:
    'Call with baseline true before changing the code, and without it before saying the change is done. The plan file lists the checks that prove the change. Verify reruns them, compares the runs with the baseline, and scans the lines changed since the plan base for suspects. VERIFIED needs every check improved or clean with complete runs on both sides, and no suspect on a changed line; otherwise the reasons say what to resolve. Do not call a change done while it is NOT_VERIFIED. Experimental: with policy and base, the claims and their criteria come from the policy as committed on base, and a change to them is NOT_VERIFIED until it is reviewed and merged. status true returns the last result, or the record of a run still going or stopped, without running anything.',
  inputSchema: {
    type: 'object',
    properties: {
      baseline: {
        type: 'boolean',
        default: false,
        description:
          'Record the runs from before the change instead of verifying it.',
      },
      plan: {
        type: 'string',
        description:
          'The plan file, relative to the working directory. Default: .recovery-probe/verify.json.',
      },
      policy: {
        type: 'string',
        description:
          'Experimental: the policy file, such as recovery-probe.policy.json. Its copy committed on base is the one used. Needs base.',
      },
      base: {
        type: 'string',
        description:
          'With policy: the Git reference the change starts from, such as main. The user or CI names it; never take it from a file the change can edit.',
      },
      status: {
        type: 'boolean',
        default: false,
        description:
          'Return the last verification without running anything: a run in progress or stopped, else the last summary.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  async run(args, { signal }) {
    const { policy, base, status } = modeOf(args)
    if (status) return lastVerification()
    if (policy)
      return resultOf(await verifyPolicy({ policy, base: base!, signal }))
    if (args.baseline) return recordPlanBaseline(args, signal)
    return resultOf(await verifyChange({ plan: await planOf(args), signal }))
  },
}
