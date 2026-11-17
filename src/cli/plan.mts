import { PlanInputError } from '../tools/plan/changes.mjs'
import {
  DEFAULT_PLAN,
  planVerification,
  writeCandidatePlan,
  type PlanReport,
} from '../tools/plan/plan.mjs'
import { integerOption, parseOptions, text, UsageError } from './args.mjs'

const USAGE =
  'recovery-probe plan [--changed-since REF] [--registry FILE] [--expect NAME=TEXT]... [--task TEXT] [--runs N] [--write FILE [--force]] [--json]'

const HELP = `${USAGE}

Proposes the checks that verify a change, before you record a baseline. It
matches the files changed since REF (main by default; committed, staged,
unstaged, untracked, deleted and renamed) against the scenario registry
(.recovery-probe/registry.json), adds the suspects on the changed lines, and
lists what has no known check or needs a decision. It runs nothing.

  --expect NAME=TEXT  the expected behavior, and its source, for a registry
                      scenario that has none, for this plan only
  --task TEXT         what the change is for; kept in the report as given
  --write FILE        write the candidate verify plan (never over an existing
                      file without --force), then run verify --baseline from
                      the version before the change, and verify after it

A plan is a proposal, never a verdict, and no matching check never means the
change is safe. Exit code: 0 every change has a planned check and nothing
needs input, 2 something to review. See docs/plan.md.`

function expectations(values: string[] | undefined) {
  const result: Record<string, string> = {}
  for (const value of values ?? []) {
    const [name, ...rest] = value.split('=')
    if (!name || !rest.join('=').trim())
      throw new UsageError('--expect takes NAME=TEXT, such as profile=PRD-12')
    result[name] = rest.join('=').trim()
  }
  return result
}

const list = (items: string[]) => items.map((item) => `    ${item}`)

function checkLines(report: PlanReport) {
  return report.checks.flatMap((check) => [
    `  ${check.name}: ${check.command.join(' ')}`,
    ...check.selectedBy.map(
      (s) =>
        `    selected by ${s.file} (${s.entry}: ${s.pattern}${s.previousPath ? ', its path before a rename' : ''})`,
    ),
    ...check.scenarios.flatMap((s) => [
      `    checks: ${s.behavior}`,
      `    expectation (${s.expectationFrom === 'user' ? 'stated for this plan' : 'registry'}): ${s.expectation}`,
      `    does not cover: ${s.notCovered}`,
    ]),
    ...check.suspects.map(
      (s) => `    suspect on a changed line: ${s.file}:${s.line} ${s.pattern}`,
    ),
  ])
}

function printPlan(report: PlanReport, written: string | undefined) {
  const { base } = report
  const lines = [
    `Verification plan for the changes since ${base.ref} (${base.commit.slice(0, 7)}): a proposal, not a verdict.`,
    `${report.changes.length} changed file(s).`,
    '',
    `Checks to run (${report.checks.length}):`,
    ...(report.checks.length ? checkLines(report) : ['  none']),
    ...(report.suggestions.length
      ? [
          '',
          'Suggestions to review (not planned):',
          ...list(report.suggestions.map((s) => `${s.file}: ${s.reason}`)),
        ]
      : []),
    ...(report.uncovered.length
      ? [
          '',
          'No known check (not the same as safe):',
          ...list(report.uncovered.map((c) => `${c.path} (${c.status})`)),
        ]
      : []),
    ...(report.needsInput.length
      ? [
          '',
          'Needs input:',
          ...list(report.needsInput.map((r) => `${r.kind}: ${r.message}`)),
        ]
      : []),
    ...(report.suspects.scanned
      ? []
      : ['', `Suspect scan did not run: ${report.suspects.error}`]),
    '',
    `Baseline: ${report.baseline.advice}`,
    report.candidatePlan
      ? written
        ? `Candidate plan written to ${written}.`
        : 'Candidate plan not written: add --write FILE, or --json to see it.'
      : 'No candidate plan: nothing above can run yet.',
  ]
  for (const line of lines) console.log(line)
}

export async function planMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const { values } = parseOptions(args, {
    'changed-since': { type: 'string' },
    registry: { type: 'string' },
    expect: { type: 'string', multiple: true },
    task: { type: 'string' },
    runs: { type: 'string' },
    write: { type: 'string' },
    force: { type: 'boolean' },
    json: { type: 'boolean' },
  })
  const write = text(values, 'write')
  try {
    const report = await planVerification({
      base: text(values, 'changed-since') ?? 'main',
      registry: text(values, 'registry'),
      task: text(values, 'task'),
      expectations: expectations(
        values.expect as unknown as string[] | undefined,
      ),
      runs: integerOption(values, 'runs', [1, 10]),
      ignored: [DEFAULT_PLAN, ...(write ? [write] : [])],
    })
    const written = write
      ? await writeCandidatePlan(report, write, values.force === true)
      : undefined
    if (values.json)
      console.log(
        JSON.stringify({ ...report, written: written ?? null }, null, 2),
      )
    else printPlan(report, written)
    process.exitCode = report.candidatePlan && !report.gaps ? 0 : 2
  } catch (error) {
    if (error instanceof PlanInputError) throw new UsageError(error.message)
    throw error
  }
}
