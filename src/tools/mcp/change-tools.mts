import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareReports } from '../compare/run.mjs'
import { scanForSuspects } from '../suspects/scan.mjs'
import { recordBaseline, verifyChange, verifyPlan } from '../verify.mjs'
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

export const verifyChangeTool: McpTool = {
  name: 'verify_change',
  title: 'Verify a code change with before and after evidence',
  description:
    'Call with baseline true before changing the code, and without it before saying the change is done. The plan file lists the checks that prove the change. Verify reruns them, compares the runs with the baseline, and scans the lines changed since the plan base for suspects. VERIFIED needs every check improved or clean with complete runs on both sides, and no suspect on a changed line; otherwise the reasons say what to resolve. Do not call a change done while it is NOT_VERIFIED.',
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
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  async run(args) {
    if (args.baseline !== undefined && typeof args.baseline !== 'boolean')
      throw new Error('baseline must be true or false')
    const planFile =
      text(args, 'plan', false) ?? join('.recovery-probe', 'verify.json')
    const plan = verifyPlan(JSON.parse(await readFile(planFile, 'utf8')))
    if (args.baseline) {
      const runs = await recordBaseline({ plan })
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
    const { verdict, reasons, checks, suspects, markdown } = await verifyChange(
      { plan },
    )
    return {
      verdict,
      reasons,
      checks: checks.map(({ name, verified, reason, comparison }) => ({
        name,
        verified,
        ...(reason ? { reason } : {}),
        ...(comparison ? { comparison: comparison.verdict } : {}),
      })),
      suspects: suspects.slice(0, MAX_SUSPECTS),
      markdown,
    }
  },
}
