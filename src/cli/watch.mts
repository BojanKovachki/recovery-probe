import { signals } from './until-stopped.mjs'
import { relative, sep } from 'node:path'
import type { RunEvidence } from '../tools/compare/types.mjs'
import { validateCheckCommand } from '../tools/watch/checks.mjs'
import {
  runWatch,
  type WatchEvent,
  type WatchOptions,
} from '../tools/watch/run.mjs'
import { integerOption, parseOptions, text, validated } from './args.mjs'

const USAGE =
  'recovery-probe watch [PATH...] [--settle MS] [--no-suspects] [--max-runs N] [--out NEW_DIRECTORY] [-- CHECK...]'

const HELP = `${USAGE}

Watches source files while you work. After each change it scans the changed
files for suspects and, with a check after --, reruns the check and compares
the run with the first one and the one before. For example:

  recovery-probe watch src -- action --config action.json

The check runs once at the start for the starting point. --settle waits until
the files have been quiet for MS (1500 by default), so a dev server can reload
first. Each run gets its own folder; summary.json and summary.md (first run
against the latest) are rewritten after every run. Stop with Ctrl+C. Exit code
after --max-runs or Ctrl+C: that of the latest comparison (0, 1 or 2), or 0.
See docs/watch.md.`

const shown = (path: string) => relative('.', path).split(sep).join('/') || '.'
const time = () => new Date().toTimeString().slice(0, 8)

type CliOptions = WatchOptions & { paths: string[]; command: string[] }

function parseArgs(args: string[]): CliOptions {
  const split = args.indexOf('--')
  const { values, positionals } = parseOptions(
    split === -1 ? args : args.slice(0, split),
    {
      'no-suspects': { type: 'boolean' },
      settle: { type: 'string' },
      'max-runs': { type: 'string' },
      out: { type: 'string' },
    },
    Infinity,
  )
  const command = split === -1 ? [] : args.slice(split + 1)
  if (command.length) validated(() => validateCheckCommand(command))
  return {
    paths: positionals,
    command,
    ...(values['no-suspects'] ? { suspects: false } : {}),
    settleMs: integerOption(values, 'settle', [0, 600000]),
    maxRuns: integerOption(values, 'max-runs', [1, 10000]),
    out: text(values, 'out'),
  }
}

const problemsOf = (evidence: RunEvidence) =>
  evidence.problems
    .map((p) => (p.scope ? `${p.code} (${p.scope})` : p.code))
    .join(', ') || 'no problem found'

type EventOf<T extends WatchEvent['type']> = Extract<WatchEvent, { type: T }>

function printStart(event: EventOf<'start'>) {
  console.log(
    `Watching ${event.paths.map(shown).join(', ')}${event.command ? `; each change reruns: recovery-probe ${event.command.join(' ')}` : '; each change is scanned for suspects'}.`,
  )
  console.log(`Runs and summary: ${shown(event.directory)}. Stop with Ctrl+C.`)
  if (event.command)
    console.log(`\n[${time()}] starting point: running the check`)
}

function printChanged(event: EventOf<'changed'>) {
  const files = event.files.slice(0, 5).join(', ')
  const more =
    event.files.length > 5 ? ` and ${event.files.length - 5} more` : ''
  console.log(`\n[${time()}] changed: ${files}${more}`)
}

function printSuspects(event: EventOf<'suspects'>) {
  if (!event.suspects.length) {
    console.log(`  suspects: none in ${event.scanned} changed source file(s)`)
    return
  }
  console.log(`  suspects: ${event.suspects.length}`)
  for (const s of event.suspects)
    console.log(
      `    ${s.file}:${s.line}  ${s.pattern}${s.read ? `  read: ${s.read}` : ''}`,
    )
}

function printRun({ run }: EventOf<'run'>) {
  // A run without an error has read its report.
  if (run.error || !run.evidence) {
    console.log(
      `  run ${run.run}: no report to compare: ${run.error} (log: ${shown(run.log)})`,
    )
    return
  }
  const incomplete = run.evidence.complete
    ? ''
    : ` (incomplete: ${run.evidence.gaps.join('; ')})`
  if (!run.sinceStart) {
    console.log(`  run ${run.run}: ${problemsOf(run.evidence)}${incomplete}`)
    return
  }
  console.log(
    `  run ${run.run}: ${run.sinceStart.verdict} since ${run.sinceStart.labels.before}: ${run.sinceStart.summary}${incomplete}`,
  )
  if (run.sincePrevious)
    console.log(
      `  ${''.padEnd(String(run.run).length + 5)} ${run.sincePrevious.verdict} since ${run.sincePrevious.labels.before}: ${run.sincePrevious.summary}`,
    )
}

function printStop(event: EventOf<'stop'>) {
  console.log(`\nStopped after ${event.runs} run(s).`)
  if (event.latest)
    console.log(
      `${event.latest.verdict} from ${event.latest.labels.before} to ${event.latest.labels.after}: ${event.latest.summary}`,
    )
}

const PRINTERS: { [T in WatchEvent['type']]: (event: EventOf<T>) => void } = {
  start: printStart,
  changed: printChanged,
  suspects: printSuspects,
  'suspects-off': (event) => console.log(`  suspects: off (${event.reason})`),
  // A run is printed when it ends.
  running: () => {},
  run: printRun,
  error: (event) => console.log(`  watch error: ${event.message}`),
  stop: printStop,
}

function print(event: WatchEvent) {
  ;(PRINTERS[event.type] as (event: WatchEvent) => void)(event)
}

export async function watchMain(args: string[]) {
  if (
    args.includes('--help') &&
    !args.slice(0, args.indexOf('--help')).includes('--')
  ) {
    console.log(HELP)
    return
  }
  const options = parseArgs(args)
  const controller = new AbortController()
  const onSignal = () => {
    if (controller.signal.aborted) process.exit(130)
    console.log(
      '\nStopping after the run in progress. Press Ctrl+C again to quit now.',
    )
    controller.abort()
  }
  signals.on('SIGINT', onSignal)
  try {
    const result = await runWatch({
      ...options,
      signal: controller.signal,
      onEvent: print,
    })
    if (result.latest)
      console.log(`Pull request block: ${shown(result.directory)}/summary.md`)
    process.exitCode = result.latest?.exitCode ?? 0
  } finally {
    signals.off('SIGINT', onSignal)
  }
}
