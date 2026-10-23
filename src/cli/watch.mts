import { signals } from './until-stopped.mjs'
import { relative, sep } from 'node:path'
import type { RunEvidence } from '../compare.mjs'
import {
  runWatch,
  validateCheckCommand,
  type WatchEvent,
  type WatchOptions,
} from '../watch.mjs'

const USAGE =
  'recovery-probe watch [PATH...] [--settle MS] [--no-suspects] [--max-runs N] [--out NEW_DIRECTORY] [-- CHECK...]'

const HELP = `${USAGE}

Watches source files while you work. After each change it scans the changed
files for suspects and, with a check after --, reruns the check and compares
the run with the first one and the one before. For example:

  recovery-probe watch src -- ipc --action --config action.json

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
  const own = split === -1 ? args : args.slice(0, split)
  const options: CliOptions = {
    paths: [],
    command: split === -1 ? [] : args.slice(split + 1),
  }
  const number = (arg: string, value: string, min: number) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < min)
      throw Error(`${arg} needs a whole number of at least ${min}`)
    return parsed
  }
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]
    if (arg === '--no-suspects') options.suspects = false
    else if (arg === '--settle') options.settleMs = number(arg, own[++i], 0)
    else if (arg === '--max-runs') options.maxRuns = number(arg, own[++i], 1)
    else if (arg === '--out') {
      if (!own[i + 1]) throw Error('--out needs a new folder')
      options.out = own[++i]
    } else if (arg.startsWith('--')) throw Error(`Use ${USAGE}`)
    else options.paths.push(arg)
  }
  if (options.command.length) validateCheckCommand(options.command)
  return options
}

const problemsOf = (evidence: RunEvidence) =>
  evidence.problems
    .map((p) => (p.scope ? `${p.code} (${p.scope})` : p.code))
    .join(', ') || 'no problem found'

function print(event: WatchEvent) {
  switch (event.type) {
    case 'start':
      console.log(
        `Watching ${event.paths.map(shown).join(', ')}${event.command ? `; each change reruns: recovery-probe ${event.command.join(' ')}` : '; each change is scanned for suspects'}.`,
      )
      console.log(
        `Runs and summary: ${shown(event.directory)}. Stop with Ctrl+C.`,
      )
      if (event.command)
        console.log(`\n[${time()}] starting point: running the check`)
      break
    case 'changed': {
      const files = event.files.slice(0, 5).join(', ')
      const more =
        event.files.length > 5 ? ` and ${event.files.length - 5} more` : ''
      console.log(`\n[${time()}] changed: ${files}${more}`)
      break
    }
    case 'suspects':
      if (!event.suspects.length) {
        console.log(
          `  suspects: none in ${event.scanned} changed source file(s)`,
        )
        break
      }
      console.log(`  suspects: ${event.suspects.length}`)
      for (const s of event.suspects)
        console.log(
          `    ${s.file}:${s.line}  ${s.pattern}${s.read ? `  read: ${s.read}` : ''}`,
        )
      break
    case 'suspects-off':
      console.log(`  suspects: off (${event.reason})`)
      break
    case 'run': {
      const { run } = event
      const log = shown(run.log)
      // A run without an error has read its report.
      if (run.error || !run.evidence) {
        console.log(
          `  run ${run.run}: no report to compare: ${run.error} (log: ${log})`,
        )
        break
      }
      const incomplete = run.evidence.complete
        ? ''
        : ` (incomplete: ${run.evidence.gaps.join('; ')})`
      if (!run.sinceStart) {
        console.log(
          `  run ${run.run}: ${problemsOf(run.evidence)}${incomplete}`,
        )
        break
      }
      console.log(
        `  run ${run.run}: ${run.sinceStart.verdict} since ${run.sinceStart.labels.before}: ${run.sinceStart.summary}${incomplete}`,
      )
      if (run.sincePrevious)
        console.log(
          `  ${''.padEnd(String(run.run).length + 5)} ${run.sincePrevious.verdict} since ${run.sincePrevious.labels.before}: ${run.sincePrevious.summary}`,
        )
      break
    }
    case 'error':
      console.log(`  watch error: ${event.message}`)
      break
    case 'stop':
      console.log(`\nStopped after ${event.runs} run(s).`)
      if (event.latest)
        console.log(
          `${event.latest.verdict} from ${event.latest.labels.before} to ${event.latest.labels.after}: ${event.latest.summary}`,
        )
      break
  }
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
