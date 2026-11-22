import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
} from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
const exec = promisify(execFile)

export interface CommandResult {
  code: number | null
  signal?: NodeJS.Signals | null
  output: string
  error?: string
  timedOut?: boolean
}

// Do not pass the patch-provider key or unrelated service credentials to generated code.
export function executionEnvironment(): NodeJS.ProcessEnv {
  const keep =
    /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|COMSPEC|PATHEXT|TMP|TEMP|TMPDIR|DISPLAY|XAUTHORITY|LANG|LC_ALL|CI|PLAYWRIGHT_BROWSERS_PATH)$/i
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => keep.test(key)),
  )
}

// Commands come from a JSON config, so their shape is checked at runtime.
export function validateCommand(command: unknown): string[] {
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.length > 100 ||
    command.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    !command[0]
  )
    throw new Error(
      'Commands must be nonempty executable/argument arrays, never shell strings',
    )
  return command
}

/**
 * Starts `command` in `cwd`. Only the last 32000 characters of output are kept in memory;
 * `log` names a file that gets all of it, written in full before the command counts as finished.
 */
export function startCommand(
  command: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  log?: string,
) {
  validateCommand(command)
  // On Windows use node + the npm CLI JS file instead of npm.cmd; no implicit shell.
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: { ...executionEnvironment(), ...extraEnv },
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const file = log ? createWriteStream(log, { mode: 0o600 }) : undefined
  let output = ''
  let error: Error | undefined
  let result: CommandResult | undefined
  const append = (data: Buffer) => {
    file?.write(data)
    output = (output + data.toString()).slice(-32000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const finished = new Promise<CommandResult>((resolve) => {
    child.on('error', (value) => {
      error = value
    })
    child.on('close', (code, signal) => {
      const closed = { code, signal, output, error: error?.message }
      result = closed
      if (file) file.end(() => resolve(closed))
      else resolve(closed)
    })
  })
  return {
    child,
    finished,
    stop: () => stopTree(child.pid, finished, () => result !== undefined),
    get result() {
      return result
    },
    get output() {
      return output
    },
  }
}

/** Stops a command and its children: taskkill on Windows, the process group elsewhere. */
async function stopTree(
  pid: number | undefined,
  finished: Promise<unknown>,
  exited: () => boolean,
) {
  if (!pid) return
  if (process.platform === 'win32') {
    if (!exited())
      await exec('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {})
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {}
    await Promise.race([finished, sleep(500)])
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  await finished
}

export async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs = 120000,
  { env, log }: { env?: Record<string, string>; log?: string } = {},
): Promise<CommandResult> {
  const processRun = startCommand(command, cwd, env, log)
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      processRun.finished,
      new Promise<CommandResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({ code: null, timedOut: true, output: processRun.output }),
          timeoutMs,
        )
      }),
    ])
    return result
  } finally {
    clearTimeout(timer)
    await processRun.stop()
  }
}

/** Asks a Recovery Probe process to stop as SIGTERM would; see acceptStopRequests. */
export const STOP_REQUEST = 'recovery-probe:stop'
/** A process's answer when nothing in it can stop gracefully, so it can be ended at once. */
export const CANNOT_STOP = 'recovery-probe:cannot-stop'
/** How long a process asked to stop has to clean up before its process tree is ended. */
export const STOP_GRACE_MS = 10000

export type StopReason = 'timed-out' | 'cancelled'

export interface StopLimits {
  signal?: AbortSignal
  timeoutMs?: number
  /** How long the process has to stop on its own; STOP_GRACE_MS by default. */
  graceMs?: number
}

/**
 * Starts `node script ...args` so that untilExit can stop it: with a channel for stop
 * requests, because on Windows a signal ends a process without running its handlers,
 * and outside Windows in its own process group, so its whole tree can be ended.
 */
export function startNode(script: string, args: string[]) {
  // Node's typings have no overload for an 'ipc' entry, so they lose the piped streams.
  return spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  }) as ChildProcessByStdio<null, Readable, Readable>
}

/**
 * Resolves once `child`, started by startNode, has exited. At the timeout or abort it
 * asks the child to stop, and ends its process tree when the child answers that it
 * can't, or hasn't stopped within the grace period.
 */
export function untilExit(
  child: ChildProcess,
  { signal, timeoutMs, graceMs = STOP_GRACE_MS }: StopLimits = {},
) {
  let exited = false
  let stopped: StopReason | undefined
  let grace: NodeJS.Timeout | undefined
  const closed = new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, killedBy) => {
        exited = true
        resolve([code, killedBy])
      })
    },
  )
  const end = () => {
    clearTimeout(grace)
    stopTree(child.pid, closed, () => exited).catch(() => {})
  }
  const stop = (reason: StopReason) => {
    if (stopped || exited) return
    stopped = reason
    // The callback takes the error of a child that has already gone.
    child.send(STOP_REQUEST, () => {})
    grace = setTimeout(end, graceMs)
  }
  child.on('message', (message) => {
    if (message === CANNOT_STOP && stopped) end()
  })
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => stop('timed-out'), timeoutMs)
  const onAbort = () => stop('cancelled')
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return closed
    .then(([exitCode, killedBy]) => ({
      exitCode,
      killedBy,
      ...(stopped ? { stopped } : {}),
    }))
    .finally(() => {
      clearTimeout(timer)
      clearTimeout(grace)
      signal?.removeEventListener('abort', onAbort)
    })
}
