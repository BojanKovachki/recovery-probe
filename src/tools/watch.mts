import { spawn } from 'node:child_process'
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareRuns,
  readRunEvidence,
  type Comparison,
  type RunEvidence,
} from './compare.mjs'
import {
  findSuspects,
  isScannable,
  SKIPPED_DIRECTORIES,
  type Suspect,
} from './suspects.mjs'
import { packageUrl } from '../core/package.mjs'

// Editor swap, backup and lock files change without the source changing.
const EDITOR_FILE =
  /(?:~|\.swp|\.swx|\.tmp)$|(?:^|[\\/])(?:\.#|#)[^\\/]*$|(?:^|[\\/])4913$/
// Commands whose reports compare run to run; each needs --config.
const CHECKS = ['ipc', 'observe', 'refresh', 'web', 'desktop']
// Flags a rerun sets itself, or that need a person at the keyboard.
const NOT_IN_A_RERUN = ['--out', '--interactive', '--help', '--list']
// Each check runs as its own CLI process, so a hung or crashing check can be stopped
// without taking the watcher down.
const CLI = fileURLToPath(packageUrl('bin/recovery-probe.mjs'))

export interface SourceWatcher {
  close(): void
}

const shown = (path: string) => relative('.', path).split(sep).join('/') || '.'

const isIgnored = (path: string) =>
  path.split(/[\\/]/).some((part) => SKIPPED_DIRECTORIES.has(part)) ||
  EDITOR_FILE.test(path)

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Calls `onChange` with the files that changed under `paths`, once they have
 * been quiet for `settleMs`. Dependencies, build output, Recovery Probe's own
 * reports and the `ignore` folders are left out.
 */
export async function watchSources(
  paths: string[],
  onChange: (files: string[]) => void,
  {
    settleMs = 1500,
    ignore = [],
    // Linux has no native recursive watch; tests turn it off elsewhere too.
    recursive = process.platform !== 'linux',
  }: { settleMs?: number; ignore?: string[]; recursive?: boolean } = {},
): Promise<SourceWatcher> {
  const ignored = ignore.map((path) => resolve(path))
  const watchers = new Map<string, FSWatcher>()
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let closed = false

  const flush = () => {
    // A folder's own event only says something inside it changed.
    const files = [...pending].filter((file) => !isDirectory(file)).sort()
    pending.clear()
    if (files.length && !closed) onChange(files)
  }
  const changed = (file: string, root: string) => {
    const path = resolve(file)
    if (
      isIgnored(relative(root, path)) ||
      ignored.some((folder) => path === folder || path.startsWith(folder + sep))
    )
      return
    pending.add(path)
    clearTimeout(timer)
    timer = setTimeout(flush, settleMs)
  }
  const add = (path: string, watcher: FSWatcher) => {
    // A watched folder that is deleted reports an error; stop watching it.
    watcher.on('error', () => {
      watcher.close()
      watchers.delete(path)
    })
    watchers.set(path, watcher)
  }

  // Linux has no native recursive watch, and Node's emulation also watches
  // node_modules; so watch each folder there and add new ones as they appear.
  const watchTree = async (folder: string, root: string, report: boolean) => {
    if (watchers.has(folder) || closed) return
    add(
      folder,
      watch(folder, (_event, name) => {
        if (!name) return
        const path = join(folder, name.toString())
        if (isIgnored(relative(root, path))) return
        if (isDirectory(path)) void watchTree(path, root, true)
        changed(path, root)
      }),
    )
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
        await watchTree(path, root, report)
      // Files in a folder that appeared after the watch started.
      else if (report && entry.isFile()) changed(path, root)
    }
  }

  for (const path of paths.map((p) => resolve(p))) {
    if (!isDirectory(path)) {
      add(
        path,
        watch(path, () => changed(path, resolve(path, '..'))),
      )
    } else if (!recursive) await watchTree(path, path, false)
    else
      add(
        path,
        watch(path, { recursive: true }, (_event, name) => {
          if (name) changed(join(path, name.toString()), path)
        }),
      )
  }
  return {
    close() {
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}

/** Throws unless `args` is a check the watch can rerun into a new folder each time. */
export function validateCheckCommand(args: string[]): void {
  const [first] = args
  if (first !== '--config' && !CHECKS.includes(first))
    throw new Error(
      `This reruns a check: --config FILE, or ${CHECKS.join(', ')} with --config FILE`,
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
  /** Recovery Probe arguments of the check to rerun, such as ["ipc", "--action", "--config", "action.json"]. */
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

const verdict = (comparison?: Comparison) =>
  comparison && {
    verdict: comparison.verdict,
    summary: comparison.summary,
  }

async function writeSummary(
  directory: string,
  command: string[] | undefined,
  runs: WatchRun[],
  latest: Comparison | undefined,
) {
  const inside = (path?: string) =>
    path && relative(directory, path).split(sep).join('/')
  const summary = {
    command,
    runs: runs.map((run) => ({
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
              problem.scope
                ? `${problem.code} (${problem.scope})`
                : problem.code,
            ),
            gaps: run.evidence.gaps,
          }
        : {}),
      sinceStart: verdict(run.sinceStart),
      sincePrevious: verdict(run.sincePrevious),
    })),
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

/**
 * Watches source files. After each change it scans the changed files for
 * suspects and reruns the check into a new folder, comparing the run with the
 * first one and the one before. Resolves when `signal` aborts or after
 * `maxRuns`, once the run in progress has finished.
 */
export async function runWatch(
  options: WatchOptions = {},
): Promise<WatchResult> {
  const paths = options.paths?.length ? options.paths : ['.']
  const command = options.command?.length ? options.command : undefined
  if (command) validateCheckCommand(command)
  let scanSuspects = options.suspects !== false
  if (!command && !scanSuspects)
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
  const emit = options.onEvent ?? (() => {})
  const runCommand = options.runCommand ?? runRecoveryProbe
  const runs: WatchRun[] = []
  let latest: Comparison | undefined

  let stopped = false
  let stop = () => {}
  const stopping = new Promise<void>((resolve) => {
    stop = () => {
      stopped = true
      resolve()
    }
  })
  if (options.signal?.aborted) stop()
  options.signal?.addEventListener('abort', stop, { once: true })

  const check = async (changed: string[]) => {
    const number = runs.length + 1
    const folder = join(directory, `run-${number}`)
    emit({ type: 'running', run: number })
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
    const reported = runs.filter((earlier) => earlier.evidence)
    const [start] = reported
    const previous = reported.at(-1)
    const compare = (earlier: WatchRun) =>
      compareRuns([earlier.evidence!], [run.evidence!], {
        before: `run ${earlier.run}`,
        after: `run ${run.run}`,
      })
    if (run.evidence && start) {
      run.sinceStart = compare(start)
      latest = run.sinceStart
      if (previous && previous !== start) run.sincePrevious = compare(previous)
    }
    runs.push(run)
    await writeSummary(directory, command, runs, latest)
    emit({ type: 'run', run })
    if (options.maxRuns && runs.length >= options.maxRuns) stop()
  }

  const scan = async (files: string[]) => {
    const sources = files.filter(
      (file) => isScannable(file, false) && existsSync(file),
    )
    if (!scanSuspects || !sources.length) return
    try {
      const suspects = (await findSuspects(sources)).map((suspect) => ({
        ...suspect,
        file: shown(suspect.file),
      }))
      emit({ type: 'suspects', scanned: sources.length, suspects })
    } catch (error) {
      scanSuspects = false
      emit({ type: 'suspects-off', reason: (error as Error).message })
    }
  }

  // One job at a time; changes during a run wait and are handled together.
  let pending: string[] = []
  let busy: Promise<void> | undefined
  const queue = (job: () => Promise<void>) => {
    busy = job()
      .catch((error: Error) => emit({ type: 'error', message: error.message }))
      .finally(() => {
        busy = undefined
        drain()
      })
  }
  const drain = () => {
    if (busy || stopped || !pending.length) return
    const files = pending
    pending = []
    queue(async () => {
      const changed = files.map(shown)
      emit({ type: 'changed', files: changed })
      await scan(files)
      if (command && !stopped) await check(changed)
    })
  }

  const watcher = await watchSources(
    paths,
    (files) => {
      pending.push(...files.filter((file) => !pending.includes(file)))
      drain()
    },
    { settleMs: options.settleMs, ignore: [directory] },
  )
  emit({ type: 'start', directory, paths, command })
  if (command) queue(() => check([]))
  await stopping
  watcher.close()
  while (busy) await busy
  emit({ type: 'stop', runs: runs.length, latest })
  return { directory, runs, latest }
}
