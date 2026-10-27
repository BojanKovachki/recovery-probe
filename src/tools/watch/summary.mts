import { writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Comparison } from '../compare/types.mjs'
import type { WatchRun } from './run.mjs'

const verdict = (comparison?: Comparison) =>
  comparison && {
    verdict: comparison.verdict,
    summary: comparison.summary,
  }

const runSummary = (directory: string, run: WatchRun) => {
  const inside = (path?: string) =>
    path && relative(directory, path).split(sep).join('/')
  return {
    run: run.run,
    at: run.at,
    changed: run.changed,
    report: inside(run.report),
    log: inside(run.log),
    exitCode: run.exitCode,
    ...(run.error ? { error: run.error } : {}),
    ...(run.evidence
      ? {
          complete: run.evidence.complete,
          problems: run.evidence.problems.map((problem) =>
            problem.scope ? `${problem.code} (${problem.scope})` : problem.code,
          ),
          gaps: run.evidence.gaps,
        }
      : {}),
    sinceStart: verdict(run.sinceStart),
    sincePrevious: verdict(run.sincePrevious),
  }
}

/** Writes summary.json with every run, and summary.md with the latest comparison. */
export async function writeSummary(
  directory: string,
  command: string[] | undefined,
  runs: WatchRun[],
  latest: Comparison | undefined,
) {
  const summary = {
    command,
    runs: runs.map((run) => runSummary(directory, run)),
    latest: verdict(latest),
  }
  await writeFile(
    join(directory, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  )
  await writeFile(
    join(directory, 'summary.md'),
    latest?.markdown ??
      'Only one run has a report so far: there is nothing to compare yet.\n',
    { mode: 0o600 },
  )
}
