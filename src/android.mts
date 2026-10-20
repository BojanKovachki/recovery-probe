import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Runs adb with the given arguments and resolves with its standard output. */
export type AdbRunner = (args: string[]) => Promise<string>

export interface AndroidDevtoolsTarget {
  /** The abstract socket name, without its leading `@`. */
  socket: string
  kind: 'webview' | 'chrome' | 'other'
  pid?: number
  /** The process that owns the socket, which is the app's package for a WebView. */
  package?: string
}

export interface AndroidForward {
  /** A DevTools endpoint for `desktop --cdp` or a config's `cdp`. */
  cdp: string
  port: number
  remove(): Promise<void>
}

/** adb from ANDROID_HOME, ANDROID_SDK_ROOT or the default Windows SDK, else from PATH. */
export function defaultAdbPath(env = process.env): string {
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const roots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk'),
  ].filter((root): root is string => Boolean(root))
  for (const root of roots) {
    const path = join(root, 'platform-tools', executable)
    if (existsSync(path)) return path
  }
  return executable
}

export function adbRunner({
  adb = defaultAdbPath(),
  serial,
}: { adb?: string; serial?: string } = {}): AdbRunner {
  return (args) =>
    new Promise((resolve, reject) =>
      execFile(
        adb,
        [...(serial ? ['-s', serial] : []), ...args],
        { timeout: 15_000, windowsHide: true },
        (error, stdout, stderr) =>
          error
            ? reject(
                new Error(
                  `adb ${args.join(' ')} failed: ${stderr.trim() || error.message}`,
                  {
                    cause: error,
                  },
                ),
              )
            : resolve(stdout),
      ),
    )
}

/** Serial numbers of the devices adb can use. */
export async function androidDevices(run: AdbRunner): Promise<string[]> {
  return (await run(['devices']))
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial)
}

/** DevTools sockets in `/proc/net/unix` output: one per WebView process or browser. */
export function parseDevtoolsSockets(
  procNetUnix: string,
): AndroidDevtoolsTarget[] {
  const sockets = new Set<string>()
  for (const line of procNetUnix.split(/\r?\n/)) {
    const path = line.trim().split(/\s+/).at(-1) ?? ''
    if (/^@[\w.]*devtools_remote(_\d+)?$/.test(path)) sockets.add(path.slice(1))
  }
  return [...sockets].map((socket) => {
    const webview = /^webview_devtools_remote_(\d+)$/.exec(socket)
    if (webview) return { socket, kind: 'webview', pid: Number(webview[1]) }
    if (socket === 'chrome_devtools_remote')
      return { socket, kind: 'chrome', package: 'com.android.chrome' }
    return { socket, kind: 'other' }
  })
}

/** Process names by process id, from `ps -A -o PID,NAME` output. */
export function parseProcesses(ps: string): Map<number, string> {
  const processes = new Map<number, string>()
  for (const line of ps.split(/\r?\n/).slice(1)) {
    const [pid, name] = line.trim().split(/\s+/)
    if (/^\d+$/.test(pid ?? '') && name) processes.set(Number(pid), name)
  }
  return processes
}

/** The WebViews and browsers on the device that can be inspected. */
export async function androidDevtoolsTargets(
  run: AdbRunner,
): Promise<AndroidDevtoolsTarget[]> {
  const targets = parseDevtoolsSockets(
    await run(['shell', 'cat', '/proc/net/unix']),
  )
  if (!targets.some((target) => target.pid !== undefined)) return targets
  const processes = parseProcesses(
    await run(['shell', 'ps', '-A', '-o', 'PID,NAME']),
  )
  return targets.map((target) =>
    target.pid === undefined
      ? target
      : { ...target, package: processes.get(target.pid) },
  )
}

/** Forwards a free local port to the socket and checks that DevTools answers there. */
export async function forwardAndroidDevtools(
  run: AdbRunner,
  socket: string,
  { port = 0, fetchVersion = (url: string) => fetch(url) } = {},
): Promise<AndroidForward> {
  const output = await run([
    'forward',
    `tcp:${port}`,
    `localabstract:${socket}`,
  ])
  const forwarded = port || Number(output.trim())
  if (!Number.isInteger(forwarded) || forwarded <= 0)
    throw new Error(`adb did not report the forwarded port: ${output.trim()}`)
  const remove = async () => {
    await run(['forward', '--remove', `tcp:${forwarded}`])
  }
  const cdp = `http://127.0.0.1:${forwarded}`
  try {
    const response = await fetchVersion(`${cdp}/json/version`)
    if (!response.ok) throw new Error(`DevTools answered ${response.status}`)
  } catch (error) {
    await remove().catch(() => {})
    throw new Error(
      `No DevTools endpoint behind ${socket}: ${(error as Error).message}`,
      {
        cause: error,
      },
    )
  }
  return { cdp, port: forwarded, remove }
}
