import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageUrl } from '../../core/package.mjs'
import { PARTIAL_REPORT, RUN_IN_PROGRESS } from '../../reports/discovery.mjs'
import { CHECK_COMMAND_OPTIONS } from '../../workflows/command-line.mjs'
import { readRunEvidence } from '../compare/reports.mjs'
import type { RunEvidence } from '../compare/types.mjs'
import {
  startNode,
  untilExit,
  type StopLimits,
  type StopReason,
} from '../process.mjs'

// Commands whose reports compare run to run; each needs --config.
const CHECKS = Object.keys(CHECK_COMMAND_OPTIONS)
// Flags a rerun sets itself, or that need a person at the keyboard.
const NOT_IN_A_RERUN = ['--out', '--interactive', '--help', '--list']
// Each check runs as its own CLI process, so a hung or crashing check can be stopped
// without taking the watcher down.
const CLI = fileURLToPath(packageUrl('bin/recovery-probe.mjs'))

/** Throws unless `args` is a check the watch can rerun into a new folder each time. */
export function validateCheckCommand(args: string[]): void {
  if (!CHECKS.includes(args[0]))
    throw new Error(
      `This reruns a check: ${CHECKS.join(', ')} with --config FILE`,
    )
  if (!args.includes('--config'))
    throw new Error(
      'The check needs --config FILE, so that every run is the same check',
    )
  const flag = args.find((arg) => NOT_IN_A_RERUN.includes(arg))
  if (flag)
    throw new Error(
      flag === '--out'
        ? 'Leave out --out: each run gets its own folder'
        : `${flag} does not work in a rerun`,
    )
}

export interface CommandResult {
  exitCode: number | null
  output: string
  /** Why the command was stopped before it finished on its own. */
  stopped?: StopReason
}

export type CheckRunner = (
  args: string[],
  limits?: StopLimits,
) => Promise<CommandResult>

/** Runs a Recovery Probe command and collects what it prints; see untilExit for `limits`. */
export async function runRecoveryProbe(
  args: string[],
  limits: StopLimits = {},
): Promise<CommandResult> {
  const child = startNode(CLI, args)
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const { exitCode, stopped } = await untilExit(child, limits)
  return { exitCode, output, ...(stopped ? { stopped } : {}) }
}

export interface CheckResult extends CommandResult {
  report?: string
  evidence?: RunEvidence
  /** Why the run has no comparable report. */
  error?: string
}

const lastLine = (output: string) =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 200)

/**
 * Runs a check once into `folder` and reads the report it wrote. A run that ended
 * before its report, with a partial one, keeps that as incomplete evidence.
 */
export async function runCheck(
  command: string[],
  folder: string,
  runCommand: CheckRunner = runRecoveryProbe,
  limits: StopLimits = {},
): Promise<CheckResult> {
  const { exitCode, output, stopped } = await runCommand(
    [...command, '--out', folder],
    limits,
  )
  const result: CheckResult = {
    exitCode,
    output,
    ...(stopped ? { stopped } : {}),
  }
  const final = join(folder, 'report.json')
  const partial = join(folder, PARTIAL_REPORT)
  const report = [final, partial].find((file) => existsSync(file))
  if (!report)
    result.error = lastLine(output) ?? `exit code ${exitCode}, and no report`
  else
    try {
      const evidence = await readRunEvidence(report)
      result.evidence = report === final ? evidence : stoppedRun(evidence)
      result.report = report
    } catch (error) {
      result.error = (error as Error).message
    }
  return result
}

/** The evidence of a partial report whose run will never finish. */
const stoppedRun = (evidence: RunEvidence): RunEvidence => ({
  ...evidence,
  complete: false,
  gaps: [
    ...evidence.gaps.filter((gap) => gap !== RUN_IN_PROGRESS),
    'PROCESS_STOPPED',
  ],
})
