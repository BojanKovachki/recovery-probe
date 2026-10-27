import { setTimeout as sleep } from 'node:timers/promises'
import {
  adbRunner,
  androidDevices,
  androidDevtoolsTargets,
  androidDisplayState,
  displayProblems,
  forwardAndroidDevtools,
  keepQuestAwake,
  type AndroidDevtoolsTarget,
  type KeptAwake,
} from '../targets/android.mjs'
import {
  startCdpBridge,
  type CdpBridge,
} from '../targets/cdp-bridge/bridge.mjs'
import { untilStopped } from './until-stopped.mjs'
import { integerOption, parseOptions, text } from './args.mjs'

const USAGE =
  'recovery-probe android [--list] [--serial SERIAL] [--package NAME] [--port N] [--duration MS] [--keep-awake] [--adb PATH]'

const HELP = `${USAGE}

Makes an Android WebView or Chrome inspectable like a desktop debugging endpoint.
It finds the app's DevTools socket over adb, forwards a local port to it and keeps
the forward until Ctrl+C or --duration. Use the printed URL with desktop --cdp, or as
"cdp" in an observe or desktop config. The app must enable WebView debugging, and the
device needs USB debugging. --list shows what can be inspected. A page draws no frames
while the display sleeps or a system dialog is in front; the command warns when it
sees either. On a Meta Quest, --keep-awake keeps the display awake and pauses the
Guardian boundary until the forward stops, so nobody has to wear the headset.
See docs/android.md.`

interface AndroidOptions {
  list?: true
  keepAwake?: true
  serial?: string
  package?: string
  port?: number
  duration?: number
  adb?: string
}

function parseArgs(args: string[]): AndroidOptions {
  const { values } = parseOptions(args, {
    list: { type: 'boolean' },
    'keep-awake': { type: 'boolean' },
    serial: { type: 'string' },
    package: { type: 'string' },
    adb: { type: 'string' },
    port: { type: 'string' },
    duration: { type: 'string' },
  })
  return {
    ...(values['list'] ? { list: true as const } : {}),
    ...(values['keep-awake'] ? { keepAwake: true as const } : {}),
    serial: text(values, 'serial'),
    package: text(values, 'package'),
    adb: text(values, 'adb'),
    port: integerOption(values, 'port', [0, 65535]),
    duration: integerOption(values, 'duration', [0, Number.MAX_SAFE_INTEGER]),
  }
}

const describe = (target: AndroidDevtoolsTarget) =>
  `${target.kind.padEnd(7)} ${target.package ?? 'unknown app'}${target.pid ? ` (pid ${target.pid})` : ''}`

export async function androidMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const options = parseArgs(args)
  let serial = options.serial
  if (!serial) {
    const devices = await androidDevices(adbRunner({ adb: options.adb }))
    if (devices.length !== 1)
      throw Error(
        devices.length
          ? `Several devices are connected (${devices.join(', ')}); choose one with --serial`
          : 'No device is connected over adb; enable USB debugging and check adb devices',
      )
    serial = devices[0]
  }
  const run = adbRunner({ adb: options.adb, serial })
  const targets = await androidDevtoolsTargets(run)

  if (options.list) {
    console.log(
      targets.length
        ? targets.map(describe).join('\n')
        : 'Nothing to inspect: no app with WebView debugging enabled is running.',
    )
    return
  }

  const matching = options.package
    ? targets.filter((target) => target.package === options.package)
    : targets
  if (matching.length !== 1)
    throw Error(
      matching.length
        ? `Several targets can be inspected; choose one with --package:\n${matching.map(describe).join('\n')}`
        : options.package
          ? `${options.package} has no WebView to inspect; is it running with WebView debugging enabled?`
          : 'Nothing to inspect: no app with WebView debugging enabled is running.',
    )

  const [target] = matching
  if (options.keepAwake && !(await androidDisplayState(run)).quest)
    throw Error('--keep-awake works on Meta Quest headsets only')
  const forward = await forwardAndroidDevtools(run, target.socket)
  let bridge: CdpBridge | undefined
  let awake: KeptAwake | undefined
  try {
    // Android keeps blank WebViews without a window that never answer DevTools; a
    // client attaching to them all would wait forever, so the bridge hides them.
    bridge = await startCdpBridge({ upstream: forward.cdp, port: options.port })
    if (options.keepAwake) {
      awake = await keepQuestAwake(run)
      // The display and the app's panel take a moment to come back.
      await sleep(3000)
    }
    const display = await androidDisplayState(run).catch(() => undefined)
    console.log(`Android ${describe(target).trim()} on ${bridge.url}

Use it like a desktop debugging endpoint:
  recovery-probe desktop --cdp ${bridge.url} --list
  "cdp": "${bridge.url}" in an observe or desktop config

Keep the app on screen while a check runs. Press Ctrl+C to remove the forward.`)
    if (awake)
      console.log(
        'Keeping the Quest display awake and the Guardian boundary paused until the forward stops.',
      )
    for (const problem of display ? displayProblems(display) : [])
      console.log(
        `Warning: ${problem} ${display?.quest && !awake ? 'Wear the headset, or use --keep-awake.' : 'Wake the device and bring the app to the front.'}`,
      )
    await untilStopped(options.duration)
  } finally {
    await awake
      ?.restore()
      .catch((error) => console.error(`Recovery Probe: ${error.message}`))
    await bridge?.close()
    await forward.remove()
  }
}
