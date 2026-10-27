import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageUrl } from '../../core/package.mjs'
import { readRunEvidence } from '../compare/reports.mjs'
import type { RunEvidence } from '../compare/types.mjs'

// Commands whose reports compare run to run; each needs --config. The old
// ipc, web and desktop spellings still run until 1.0.
const CHECKS = ['check', 'discover', 'action', 'observe', 'refresh']
const OLD_CHECKS = ['ipc', 'web', 'desktop']
// Flags a rerun sets itself, or that need a person at the keyboard.
const NOT_IN_A_RERUN = ['--out', '--interactive', '--help', '--list']
// Each check runs as its own CLI process, so a hung or crashing check can be stopped
// without taking the watcher down.
const CLI = fileURLToPath(packageUrl('bin/recovery-probe.mjs'))

/** Throws unless `args` is a check the watch can rerun into a new folder each time. */
export function validateCheckCommand(args: string[]): void {
  const [first] = args
  if (
    first !== '--config' &&
    !CHECKS.includes(first) &&
    !OLD_CHECKS.includes(first)
  )
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
}

/** Runs a Recovery Probe command and collects what it prints. */
export function runRecoveryProbe(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ exitCode, output }))
  })
}

export interface CheckResult {
  exitCode: number | null
  output: string
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

/** Runs a check once into `folder` and reads the report it wrote. */
export async function runCheck(
  command: string[],
  folder: string,
  runCommand: (args: string[]) => Promise<CommandResult> = runRecoveryProbe,
): Promise<CheckResult> {
  const { exitCode, output } = await runCommand([
    ...command,
    '--out',
    command[0] === '--config' ? join(folder, 'report.json') : folder,
  ])
  const result: CheckResult = { exitCode, output }
  const report = join(folder, 'report.json')
  if (!existsSync(report))
    result.error = lastLine(output) ?? `exit code ${exitCode}, and no report`
  else
    try {
      result.evidence = await readRunEvidence(report)
      result.report = report
    } catch (error) {
      result.error = (error as Error).message
    }
  return result
}
