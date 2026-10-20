import {
  adbRunner,
  androidDevices,
  androidDevtoolsTargets,
  forwardAndroidDevtools,
} from '../dist/android.mjs'
import { startCdpBridge } from '../dist/cdp-bridge.mjs'
import { untilStopped } from './until-stopped.mjs'

const USAGE =
  'recovery-probe android [--list] [--serial SERIAL] [--package NAME] [--port N] [--duration MS] [--adb PATH]'

const HELP = `${USAGE}

Makes an Android WebView or Chrome inspectable like a desktop debugging endpoint.
It finds the app's DevTools socket over adb, forwards a local port to it and keeps
the forward until Ctrl+C or --duration. Use the printed URL with desktop --cdp, or as
"cdp" in an observe or desktop config. The app must enable WebView debugging, and the
device needs USB debugging. --list shows what can be inspected. See docs/android.md.`

function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = args[i + 1]
    if (arg === '--list') options.list = true
    else if (
      ['--serial', '--package', '--port', '--duration', '--adb'].includes(
        arg,
      ) &&
      value &&
      !value.startsWith('--')
    ) {
      options[arg.slice(2)] = value
      i++
    } else throw Error(`Use ${USAGE}`)
  }
  for (const key of ['port', 'duration'])
    if (options[key] !== undefined) {
      options[key] = Number(options[key])
      if (!Number.isInteger(options[key]) || options[key] < 0)
        throw Error(`--${key} must be a whole number`)
    }
  return options
}

const describe = (target) =>
  `${target.kind.padEnd(7)} ${target.package ?? 'unknown app'}${target.pid ? ` (pid ${target.pid})` : ''}`

export async function androidMain(args) {
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
  const forward = await forwardAndroidDevtools(run, target.socket)
  let bridge
  try {
    // Android keeps blank WebViews without a window that never answer DevTools; a
    // client attaching to them all would wait forever, so the bridge hides them.
    bridge = await startCdpBridge({ upstream: forward.cdp, port: options.port })
    console.log(`Android ${describe(target).trim()} on ${bridge.url}

Use it like a desktop debugging endpoint:
  recovery-probe desktop --cdp ${bridge.url} --list
  "cdp": "${bridge.url}" in an observe or desktop config

Keep the app on screen while a check runs. Press Ctrl+C to remove the forward.`)
    await untilStopped(options.duration)
  } finally {
    await bridge?.close()
    await forward.remove()
  }
}
