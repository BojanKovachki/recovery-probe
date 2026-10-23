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

export interface AndroidDisplayState {
  /** A Meta Quest headset, recognised by its manufacturer or Guardian. */
  quest: boolean
  awake: boolean
  /** The package of the window with input focus, such as com.oculus.guardian. */
  focus?: string
}

// A broadcast namespace of the Quest system, not an installed package.
const QUEST_POWER_MANAGER = 'com.oculus.vrpowermanager'
const GUARDIAN = 'com.oculus.guardian'
const GUARDIAN_PAUSE = 'debug.oculus.guardian_pause'

const isQuest = async (run: AdbRunner) => {
  const manufacturer = await run([
    'shell',
    'getprop',
    'ro.product.manufacturer',
  ])
  if (/^(oculus|meta)$/i.test(manufacturer.trim())) return true
  return run(['shell', 'pm', 'path', GUARDIAN]).then(
    (output) => output.includes('package:'),
    () => false,
  )
}

/** Whether the display is awake and which app has focus: a page draws no frames otherwise. */
export async function androidDisplayState(
  run: AdbRunner,
): Promise<AndroidDisplayState> {
  const power = await run(['shell', 'dumpsys', 'power'])
  const window = await run(['shell', 'dumpsys', 'window'])
  const quest = await isQuest(run)
  const focus = /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\//.exec(window)?.[1]
  return {
    quest,
    awake: /mWakefulness=Awake/.test(power),
    ...(focus ? { focus } : {}),
  }
}

/** Why a page on this display would draw no frames, if it would not. */
export function displayProblems(state: AndroidDisplayState): string[] {
  const problems: string[] = []
  if (!state.awake)
    problems.push(
      'The display is asleep, so the page draws no frames: clicks time out and the screen does not update.',
    )
  if (state.focus === GUARDIAN)
    problems.push(
      'The Guardian boundary dialog is in front of the app, so the app draws no frames.',
    )
  return problems
}

export interface KeptAwake {
  /** Puts Guardian and the display's proximity handling back as they were. */
  restore(): Promise<void>
}

/**
 * Keeps a Quest's display awake without anyone wearing it, and pauses the
 * Guardian boundary dialog that would otherwise take focus from the app.
 */
export async function keepQuestAwake(run: AdbRunner): Promise<KeptAwake> {
  const previous = (await run(['shell', 'getprop', GUARDIAN_PAUSE])).trim()
  const restoreCommands = [
    ['shell', 'setprop', GUARDIAN_PAUSE, previous || '0'],
    [
      'shell',
      'am',
      'broadcast',
      '-a',
      `${QUEST_POWER_MANAGER}.automation_disable`,
    ],
  ]
  const restore = async () => {
    const failures: string[] = []
    for (const args of restoreCommands)
      await run(args).catch((error: Error) => failures.push(error.message))
    if (failures.length)
      throw new Error(
        `Could not restore the headset (${failures.join('; ')}); run ${restoreCommands.map((args) => `adb ${args.join(' ')}`).join(' and ')}`,
      )
  }
  try {
    await run([
      'shell',
      'am',
      'broadcast',
      '-a',
      `${QUEST_POWER_MANAGER}.prox_close`,
    ])
    await run(['shell', 'setprop', GUARDIAN_PAUSE, '1'])
  } catch (error) {
    await restore().catch(() => {})
    throw error
  }
  return { restore }
}
