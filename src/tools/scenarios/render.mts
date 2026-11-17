import { problemKey } from './guidance.mjs'
import type { ScenarioSelfCheck, SelfCheckReport } from './self-check.mjs'

const OUTCOME: Record<ScenarioSelfCheck['outcome'], string> = {
  'configuration-error': 'configuration error: not run',
  'preflight-passed': 'static preflight passed; not run',
  'execution-failed': 'execution failed: a run could not do its work',
  incomplete: 'incomplete observation: a run did not complete',
  inconsistent: 'inconsistent: the runs disagree',
  findings: 'findings on the reference build, the same on every run',
  clean: 'clean on every run of the reference build',
}

const list = (title: string, items: string[]) =>
  items.length ? [`- ${title}:`, ...items.map((item) => `  - ${item}`)] : []

function runLines(scenario: ScenarioSelfCheck) {
  return scenario.runs.map((run) => {
    if (run.error)
      return `  - run ${run.run}: failed (${run.error})${run.report ? `; ${run.report}` : ''}`
    const problems = run.problems.map((p) => `${problemKey(p)} (${p.severity})`)
    return `  - run ${run.run}: ${run.complete ? 'complete' : `incomplete (${run.gaps.join('; ')})`}; ${problems.length ? problems.join(', ') : 'no findings'}; ${run.report}`
  })
}

function scenarioLines(scenario: ScenarioSelfCheck) {
  const { preflight } = scenario
  return [
    `### ${scenario.name}: ${OUTCOME[scenario.outcome]}`,
    '',
    `- check: \`${scenario.command.join(' ')}\``,
    ...list('configuration errors', preflight.errors),
    ...list('unresolved values', preflight.unresolved),
    ...list('needs at runtime', preflight.requires),
    ...(scenario.runs.length ? ['- runs:', ...runLines(scenario)] : []),
    ...list(
      'differences between runs',
      scenario.differences.map(
        (d) =>
          `${d.code} (${d.kind}): in run(s) ${d.presentIn.join(', ')}, not in ${d.absentIn.join(', ')}`,
      ),
    ),
    ...list('guidance', scenario.guidance),
    '',
  ]
}

/** The self-check report as Markdown, for a person or a pull request. */
export function markdownOf(report: SelfCheckReport): string {
  const reference = report.reference
    ? `Reference build, as declared by you: **${report.reference.label}** (${report.runs} run(s) per scenario).`
    : 'Static preflight only: nothing was started, run or contacted.'
  return `${[
    `## Recovery Probe scenario self-check (${report.mode})`,
    '',
    reference,
    '',
    `Result: ${report.passed ? 'passed' : 'needs review'}.`,
    '',
    ...report.scenarios.flatMap(scenarioLines),
    ...list(
      'Registry entries that could not be checked',
      report.invalidEntries.map(
        (e) =>
          `${e.entry}: ${e.message}${e.selected ? '' : ' (not among the selected scenarios)'}`,
      ),
    ),
    ...(report.unknown.length
      ? ['', `Not in the registry: ${report.unknown.join(', ')}.`]
      : []),
    '',
    '#### What this does not show',
    '',
    ...report.limits.map((limit) => `- ${limit}`),
  ].join('\n')}\n`
}
