import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
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

export function startCommand(
  command: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
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
  let output = ''
  let error: Error | undefined
  let result: CommandResult | undefined
  const append = (data: Buffer) => {
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
      resolve(closed)
    })
  })
  const stop = async () => {
    const pid = child.pid
    if (!pid) return
    if (process.platform === 'win32') {
      if (!result)
        await exec('taskkill', ['/PID', String(pid), '/T', '/F']).catch(
          () => {},
        )
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {}
      await Promise.race([
        finished,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ])
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
    await finished
  }
  return {
    child,
    finished,
    stop,
    get result() {
      return result
    },
    get output() {
      return output
    },
  }
}

export async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs = 120000,
): Promise<CommandResult> {
  const processRun = startCommand(command, cwd)
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
