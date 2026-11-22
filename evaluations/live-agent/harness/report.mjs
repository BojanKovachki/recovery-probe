// The Markdown summary of a graded run: counts per task and condition, then every attempt.

const number = (value, digits = 1) =>
  typeof value === 'number' ? value.toFixed(digits) : '–'
const of = (count, total) => `${count}/${total}`
const list = (items) => (items.length ? items.join(', ') : '–')

function byTask(summary) {
  return [
    '| Task | Condition | Successes | Fixed | With regressions | Incorrect claims | Unnecessary changes | Clarified | Not completed | Isolation flags | Median minutes | Median turns | Median cost (USD) | Median RP calls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary
      .map((row) =>
        [
          row.task,
          row.condition,
          of(row.successes, row.attempts),
          of(row.fixed, row.attempts),
          of(row.withRegressions, row.attempts),
          of(row.incorrectClaims, row.attempts),
          of(row.unnecessaryChanges, row.attempts),
          of(row.clarified, row.attempts),
          of(row.notCompleted, row.attempts),
          of(row.isolationFlagged, row.attempts),
          number(row.medianMinutes),
          number(row.medianTurns, 0),
          number(row.medianCostUsd, 2),
          number(row.medianRecoveryProbeCalls, 0),
        ].join(' | '),
      )
      .map((line) => `| ${line} |`),
  ]
}

function everyAttempt(attempts) {
  return [
    '| Order | Attempt | Status | Success | Required checks failing | Regressions | App source changed | Execution | Minutes | Turns | Cost (USD) | RP calls | Isolation flags |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[...attempts]
      .sort((a, b) => a.order - b.order)
      .map(({ order, id, score, metrics }) =>
        [
          order,
          id,
          score.status ?? 'none',
          score.success ? 'yes' : 'no',
          list(score.requiredFailing),
          list(score.regressions),
          list(score.sourceChanges),
          score.execution,
          number(metrics.wallMs / 60000),
          metrics.turns ?? '–',
          number(metrics.costUsd, 2),
          metrics.recoveryProbeCalls,
          score.isolationFlags,
        ].join(' | '),
      )
      .map((line) => `| ${line} |`),
  ]
}

export function markdownSummary(pilot, attempts, summary) {
  const sorted = [...summary].sort(
    (a, b) =>
      pilot.tasks.indexOf(a.task) - pilot.tasks.indexOf(b.task) ||
      a.condition.localeCompare(b.condition),
  )
  return `${[
    `# Live-agent pilot results: ${pilot.id}`,
    '',
    `Claude Code ${pilot.agent.version}, model ${pilot.agent.model}, ${pilot.repetitions} attempt(s) per task and condition, at most ${pilot.agent.minutes} minutes and ${pilot.agent.maxTurns} turns each. Condition B adds Recovery Probe ${pilot.recoveryProbe}.`,
    '',
    "A small pilot: these counts are not conclusive statistical evidence. Costs are the CLI's estimates; the attempts ran on a subscription.",
    '',
    '## By task and condition',
    '',
    ...byTask(sorted),
    '',
    '## Every attempt',
    '',
    ...everyAttempt(attempts),
  ].join('\n')}\n`
}
