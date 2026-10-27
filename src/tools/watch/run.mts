import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { compareRuns } from '../compare/run.mjs'
import type { Comparison, RunEvidence } from '../compare/types.mjs'
import { isScannable } from '../suspects/files.mjs'
import { findSuspects, type Suspect } from '../suspects/source.mjs'
import {
  runCheck,
  runRecoveryProbe,
  validateCheckCommand,
  type CommandResult,
} from './checks.mjs'
import { watchSources } from './sources.mjs'
import { writeSummary } from './summary.mjs'

export interface WatchRun {
  run: number
  at: string
  /** Files whose change started the run; empty for the first run. */
  changed: string[]
  directory: string
  log: string
  exitCode: number | null
  report?: string
  /** Why the run has no comparable report. */
  error?: string
  evidence?: RunEvidence
  /** Compared with the first run that wrote a report. */
  sinceStart?: Comparison
  /** Compared with the run before, when that is not the first. */
  sincePrevious?: Comparison
}

export type WatchEvent =
  | { type: 'start'; directory: string; paths: string[]; command?: string[] }
  | { type: 'changed'; files: string[] }
  | { type: 'suspects'; scanned: number; suspects: Suspect[] }
  | { type: 'suspects-off'; reason: string }
  | { type: 'running'; run: number }
  | { type: 'run'; run: WatchRun }
  | { type: 'error'; message: string }
  | { type: 'stop'; runs: number; latest?: Comparison }

export interface WatchOptions {
  /** Files and folders to watch; the working directory by default. */
  paths?: string[]
  /** Recovery Probe arguments of the check to rerun, such as ["action", "--config", "action.json"]. */
  command?: string[]
  /** How long the files must be quiet before a run, so a dev server can reload first. */
  settleMs?: number
  /** Scan changed files for suspects; true by default. */
  suspects?: boolean
  /** A new folder for the runs; .recovery-probe/watch-TIME by default. */
  out?: string
  /** Stop after this many runs of the check. */
  maxRuns?: number
  signal?: AbortSignal
  onEvent?: (event: WatchEvent) => void
  runCommand?: (args: string[]) => Promise<CommandResult>
}

export interface WatchResult {
  directory: string
  runs: WatchRun[]
  /** The first run with a report compared with the last one. */
  latest?: Comparison
}

interface WatchPlan {
  paths: string[]
  command?: string[]
  directory: string
}

const shown = (path: string) => relative('.', path).split(sep).join('/') || '.'

/** Checks the options and creates the folder for the runs. */
async function prepare(options: WatchOptions): Promise<WatchPlan> {
  const paths = options.paths?.length ? options.paths : ['.']
  const command = options.command?.length ? options.command : undefined
  if (command) validateCheckCommand(command)
  if (!command && options.suspects === false)
    throw new Error(
      'Nothing to do on a change: give a check after --, or leave the suspect scan on',
    )
  for (const path of paths)
    if (!existsSync(path)) throw new Error(`${path} does not exist`)
  const directory = resolve(
    options.out ??
      join(
        '.recovery-probe',
        `watch-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      ),
  )
  if (existsSync(directory))
    throw new Error(`${directory} already exists; give a new folder`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  return { paths, command, directory }
}

/**
 * Watches source files. After each change it scans the changed files for
 * suspects and reruns the check into a new folder, comparing the run with the
 * first one and the one before. Resolves when `signal` aborts or after
 * `maxRuns`, once the run in progress has finished.
 */
export async function runWatch(
  options: WatchOptions = {},
): Promise<WatchResult> {
  return new Watch(options, await prepare(options)).run()
}

class Watch {
  readonly #options: WatchOptions
  readonly #plan: WatchPlan
  readonly #emit: (event: WatchEvent) => void
  readonly #runs: WatchRun[] = []
  readonly #stopping: Promise<void>
  #latest: Comparison | undefined
  #scanSuspects: boolean
  #stopped = false
  #stop = () => {}
  // One job at a time; changes during a run wait and are handled together.
  #pending: string[] = []
  #busy: Promise<void> | undefined

  constructor(options: WatchOptions, plan: WatchPlan) {
    this.#options = options
    this.#plan = plan
    this.#emit = options.onEvent ?? (() => {})
    this.#scanSuspects = options.suspects !== false
    this.#stopping = new Promise<void>((resolve) => {
      this.#stop = () => {
        this.#stopped = true
        resolve()
      }
    })
    if (options.signal?.aborted) this.#stop()
    options.signal?.addEventListener('abort', () => this.#stop(), {
      once: true,
    })
  }

  async run(): Promise<WatchResult> {
    const { paths, command, directory } = this.#plan
    const watcher = await watchSources(
      paths,
      (files) => {
        this.#pending.push(
          ...files.filter((file) => !this.#pending.includes(file)),
        )
        this.#drain()
      },
      { settleMs: this.#options.settleMs, ignore: [directory] },
    )
    this.#emit({ type: 'start', directory, paths, command })
    if (command) this.#queue(() => this.#check([]))
    await this.#stopping
    watcher.close()
    while (this.#busy) await this.#busy
    const latest = this.#latest
    this.#emit({ type: 'stop', runs: this.#runs.length, latest })
    return { directory, runs: this.#runs, latest }
  }

  #queue(job: () => Promise<void>) {
    this.#busy = job()
      .catch((error: Error) =>
        this.#emit({ type: 'error', message: error.message }),
      )
      .finally(() => {
        this.#busy = undefined
        this.#drain()
      })
  }

  #drain() {
    if (this.#busy || this.#stopped || !this.#pending.length) return
    const files = this.#pending
    this.#pending = []
    this.#queue(async () => {
      const changed = files.map(shown)
      this.#emit({ type: 'changed', files: changed })
      await this.#scan(files)
      if (this.#plan.command && !this.#stopped) await this.#check(changed)
    })
  }

  async #scan(files: string[]) {
    const sources = files.filter(
      (file) => isScannable(file, false) && existsSync(file),
    )
    if (!this.#scanSuspects || !sources.length) return
    try {
      const suspects = (await findSuspects(sources)).map((suspect) => ({
        ...suspect,
        file: shown(suspect.file),
      }))
      this.#emit({ type: 'suspects', scanned: sources.length, suspects })
    } catch (error) {
      this.#scanSuspects = false
      this.#emit({ type: 'suspects-off', reason: (error as Error).message })
    }
  }

  async #check(changed: string[]) {
    const { directory, command } = this.#plan
    const number = this.#runs.length + 1
    const folder = join(directory, `run-${number}`)
    this.#emit({ type: 'running', run: number })
    const runCommand = this.#options.runCommand ?? runRecoveryProbe
    const { output, ...result } = await runCheck(command!, folder, runCommand)
    const run: WatchRun = {
      run: number,
      at: new Date().toISOString(),
      changed,
      directory: folder,
      log: join(directory, `run-${number}.log`),
      ...result,
    }
    await writeFile(run.log, output, { mode: 0o600 })
    this.#compare(run)
    this.#runs.push(run)
    await writeSummary(directory, command, this.#runs, this.#latest)
    this.#emit({ type: 'run', run })
    const { maxRuns } = this.#options
    if (maxRuns && this.#runs.length >= maxRuns) this.#stop()
  }

  /** Compares a run with the first run that wrote a report, and with the one before. */
  #compare(run: WatchRun) {
    const reported = this.#runs.filter((earlier) => earlier.evidence)
    const [start] = reported
    const previous = reported.at(-1)
    if (!run.evidence || !start) return
    const compare = (earlier: WatchRun) =>
      compareRuns([earlier.evidence!], [run.evidence!], {
        before: `run ${earlier.run}`,
        after: `run ${run.run}`,
      })
    run.sinceStart = compare(start)
    this.#latest = run.sinceStart
    if (previous && previous !== start) run.sincePrevious = compare(previous)
  }
}
