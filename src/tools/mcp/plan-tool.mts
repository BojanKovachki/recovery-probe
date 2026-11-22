import { isRecord } from '../../core/validate.mjs'
import {
  DEFAULT_PLAN,
  planVerification,
  writeCandidatePlan,
} from '../plan/plan.mjs'
import { proposeChecks } from '../verify/propose.mjs'
import { integer, text } from './args.mjs'
import type { McpTool } from './server.mjs'

function expectations(args: Record<string, unknown>) {
  const value = args.expectations ?? {}
  if (
    !isRecord(value) ||
    Object.values(value).some(
      (text) => typeof text !== 'string' || !text.trim(),
    )
  )
    throw new Error(
      'expectations must map registry scenario names to expectation text',
    )
  return value as Record<string, string>
}

export const planVerificationTool: McpTool = {
  name: 'plan_verification',
  title: 'Propose the checks that verify a code change',
  description:
    'Experimental. Before recording a baseline, proposes which existing Recovery Probe checks verify a change: it matches the files changed since a Git reference (committed, staged, unstaged, untracked, deleted, renamed) against the project scenario registry (recovery-probe.registry.json) and the suspects on the changed lines. Each check says which file selected it, what it checks, where its expectation came from and what it does not cover. It also lists suggestions to review, changed files with no known check, and what needs a person: open questions, missing expectations, invalid entries. It runs nothing. The result is a proposal, never a verdict: no matching check does not mean the change is safe. Resolve needsInput, then record the baseline with verify_change from the version before the change.',
  inputSchema: {
    type: 'object',
    properties: {
      base: {
        type: 'string',
        default: 'main',
        description: 'The Git reference the change starts from.',
      },
      registry: {
        type: 'string',
        description:
          'The scenario registry, relative to the working directory. Default: recovery-probe.registry.json.',
      },
      expectations: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Expected behavior, and where it comes from, for registry scenarios that state none, by scenario name. Only what the user said; never invent one.',
      },
      task: {
        type: 'string',
        description: 'What the change is for, kept in the report as given.',
      },
      runs: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description:
          'Runs of each check on each side in the candidate plan. Default: 3.',
      },
      write: {
        type: 'string',
        description:
          'Write the candidate verify plan to this relative path, such as .recovery-probe/verify.json.',
      },
      force: {
        type: 'boolean',
        default: false,
        description: 'Replace an existing plan file. Only after reviewing it.',
      },
      proposeChecks: {
        type: 'boolean',
        default: false,
        description:
          "Also propose project checks (type checking, linting, tests) and setup from the project's configuration, with the evidence for each, for a verify policy. Nothing runs; a person approves them.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  async run(args) {
    for (const key of ['force', 'proposeChecks'])
      if (args[key] !== undefined && typeof args[key] !== 'boolean')
        throw new Error(`${key} must be true or false`)
    const write = text(args, 'write', false)
    const report = await planVerification({
      base: text(args, 'base', false) ?? 'main',
      registry: text(args, 'registry', false),
      task: text(args, 'task', false),
      expectations: expectations(args),
      runs: integer(args, 'runs', [1, 10]),
      ignored: [DEFAULT_PLAN, ...(write ? [write] : [])],
    })
    const written = write
      ? await writeCandidatePlan(report, write, args.force === true)
      : undefined
    return {
      ...report,
      written: written ?? null,
      ...(args.proposeChecks
        ? { proposedChecks: await proposeChecks(process.cwd()) }
        : {}),
    }
  },
}
