import {
  compareReports,
  describeRuns,
  describeSide,
  type ChangeStatus,
  type Comparison,
  type RunEvidence,
} from '../tools/compare.mjs'

const USAGE =
  'recovery-probe compare --before REPORT... --after REPORT... [--before-label TEXT] [--after-label TEXT] [--markdown | --json]'

const HELP = `${USAGE}

Compares reports of the same check from before and after a change, such as
main and a pull request branch. REPORT is a report.json or its folder; give
several runs per side to compare repeated runs. A problem counts as found from
any run, but as gone only when a complete run after the change checked it, so a
run that stopped early never reads as a fix. --markdown prints a block for a
pull request. Exit 0: improved, or no problem on either side; 1: a new suspected
defect or failed check; 2: anything else to review. See docs/compare.md.`

const STATUS: Record<ChangeStatus, string> = {
  NEW: 'new',
  STILL: 'still there',
  GONE: 'gone',
  UNVERIFIED: 'not checked to the end',
}

type Side = 'before' | 'after'

interface CompareOptions {
  before: string[]
  after: string[]
  labels: { before?: string; after?: string }
  format?: 'json' | 'markdown'
}

function parseArgs(args: string[]): CompareOptions {
  const options: CompareOptions = { before: [], after: [], labels: {} }
  let side: Side | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--before' || arg === '--after') side = arg.slice(2) as Side
    else if (arg === '--json' || arg === '--markdown') {
      options.format = arg.slice(2) as 'json' | 'markdown'
      side = undefined
    } else if (arg === '--before-label' || arg === '--after-label') {
      if (!args[i + 1] || args[i + 1].startsWith('--'))
        throw Error(`${arg} needs a text, such as main`)
      options.labels[arg.slice(2, -'-label'.length) as Side] = args[++i]
      side = undefined
    } else if (arg.startsWith('--') || !side) throw Error(`Use ${USAGE}`)
    else options[side].push(arg)
  }
  if (!options.before.length || !options.after.length)
    throw Error(`Give reports on both sides: ${USAGE}`)
  return options
}

function printText(comparison: Comparison) {
  const { labels } = comparison
  console.log(
    `Recovery Probe comparison${comparison.mode ? `: ${comparison.mode}` : ''}${comparison.target ? `, ${comparison.target}` : ''}`,
  )
  console.log(`  ${labels.before}: ${describeRuns(comparison.before)}`)
  console.log(`  ${labels.after}: ${describeRuns(comparison.after)}`)
  if (comparison.changes.length) console.log('')
  for (const change of comparison.changes) {
    const problem = `${change.code}${change.scope ? ` (${change.scope})` : ''}`
    console.log(
      `  ${STATUS[change.status].padEnd(22)} ${problem.padEnd(36)} ${change.severity === 'defect' ? 'suspected defect' : 'lead'}`,
    )
    console.log(
      `  ${''.padEnd(22)} ${labels.before}: ${describeSide(change.before)}; ${labels.after}: ${describeSide(change.after)}`,
    )
  }
  const { outcomes } = comparison
  if (outcomes.before.length || outcomes.after.length)
    console.log(
      `\n  Other outcomes: ${labels.before} ${outcomes.before.join(', ') || 'none'}; ${labels.after} ${outcomes.after.join(', ') || 'none'}`,
    )
  const sides: [string, RunEvidence[]][] = [
    [labels.before, comparison.before],
    [labels.after, comparison.after],
  ]
  for (const [label, runs] of sides)
    for (const run of runs)
      if (run.gaps.length)
        console.log(
          `\n  ${label} ${run.complete ? 'partial' : 'incomplete'}, ${run.path}:\n    ${run.gaps.join('\n    ')}`,
        )
  console.log(`\n${comparison.verdict}: ${comparison.summary}`)
  if (comparison.limitation)
    console.log(`Covers only this check. ${comparison.limitation}`)
}

export async function compareMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const options = parseArgs(args)
  const comparison = await compareReports(
    options.before,
    options.after,
    options.labels,
  )
  if (options.format === 'json')
    console.log(JSON.stringify(comparison, null, 2))
  else if (options.format === 'markdown')
    process.stdout.write(comparison.markdown)
  else printText(comparison)
  process.exitCode = comparison.exitCode
}
