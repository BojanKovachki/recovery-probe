import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  androidDevices,
  androidDevtoolsTargets,
  forwardAndroidDevtools,
  parseDevtoolsSockets,
  parseProcesses,
  defaultAdbPath,
  androidDisplayState,
  displayProblems,
  keepQuestAwake,
} from '../../dist/targets/android.mjs'
import { fake } from '../helpers/fake.mjs'

// Shaped like a device's output; the same discovery chrome://inspect uses.
const PROC_NET_UNIX = `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 101 @webview_devtools_remote_4321
0000000000000000: 00000003 00000000 00000000 0001 03 102 @webview_devtools_remote_4321
0000000000000000: 00000002 00000000 00010000 0001 01 103 @chrome_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 104 /dev/socket/logdw
0000000000000000: 00000002 00000000 00010000 0001 01 105 @jdwp-control
`
const PS = `  PID NAME
    1 init
 4321 com.example.reader
 5000 com.android.chrome
`

/** An adb that answers the commands it knows, and records them. */
function fakeAdb(answers) {
  const calls = []
  const run = async (args) => {
    calls.push(args.join(' '))
    const answer = answers[args.join(' ')]
    if (answer instanceof Error) throw answer
    if (answer === undefined) throw Error(`unexpected adb ${args.join(' ')}`)
    return answer
  }
  return { run, calls }
}

test('finds WebView and Chrome DevTools sockets once each', () => {
  assert.deepEqual(parseDevtoolsSockets(PROC_NET_UNIX), [
    { socket: 'webview_devtools_remote_4321', kind: 'webview', pid: 4321 },
    {
      socket: 'chrome_devtools_remote',
      kind: 'chrome',
      package: 'com.android.chrome',
    },
  ])
})

test('names a WebView by the app that owns it', async () => {
  assert.equal(parseProcesses(PS).get(4321), 'com.example.reader')
  const { run } = fakeAdb({
    'shell cat /proc/net/unix': PROC_NET_UNIX,
    'shell ps -A -o PID,NAME': PS,
  })
  assert.deepEqual(await androidDevtoolsTargets(run), [
    {
      socket: 'webview_devtools_remote_4321',
      kind: 'webview',
      pid: 4321,
      package: 'com.example.reader',
    },
    {
      socket: 'chrome_devtools_remote',
      kind: 'chrome',
      package: 'com.android.chrome',
    },
  ])
})

test('lists only devices ready for adb', async () => {
  const { run } = fakeAdb({
    devices:
      'List of devices attached\nemulator-5554\tdevice\nheadset01\tunauthorized\n\n',
  })
  assert.deepEqual(await androidDevices(run), ['emulator-5554'])
})

test('forwards a free port and checks that DevTools answers', async () => {
  const { run, calls } = fakeAdb({
    'forward tcp:0 localabstract:webview_devtools_remote_4321': '51234\n',
    'forward --remove tcp:51234': '',
  })
  const versions = []
  const forward = await forwardAndroidDevtools(
    run,
    'webview_devtools_remote_4321',
    { fetchVersion: async (url) => (versions.push(url), fake({ ok: true })) },
  )
  assert.equal(forward.cdp, 'http://127.0.0.1:51234')
  assert.deepEqual(versions, ['http://127.0.0.1:51234/json/version'])
  await forward.remove()
  assert.deepEqual(calls, [
    'forward tcp:0 localabstract:webview_devtools_remote_4321',
    'forward --remove tcp:51234',
  ])
})

// A socket without a working DevTools behind it must not leave a forward behind.
test('removes the forward when nothing answers behind the socket', async () => {
  const { run, calls } = fakeAdb({
    'forward tcp:9333 localabstract:chrome_devtools_remote': '',
    'forward --remove tcp:9333': '',
  })
  await assert.rejects(
    forwardAndroidDevtools(run, 'chrome_devtools_remote', {
      port: 9333,
      fetchVersion: async () => {
        throw Error('socket hang up')
      },
    }),
    /No DevTools endpoint behind chrome_devtools_remote: socket hang up/,
  )
  assert.equal(calls.at(-1), 'forward --remove tcp:9333')
})

test('falls back to adb on PATH without an Android SDK', () => {
  assert.equal(
    defaultAdbPath({}),
    process.platform === 'win32' ? 'adb.exe' : 'adb',
  )
})

// Shaped like a Quest whose display sleeps behind the Guardian boundary dialog.
const QUEST_ASLEEP = {
  'shell dumpsys power': 'Power Manager State:\n  mWakefulness=Asleep\n',
  'shell dumpsys window':
    '  mCurrentFocus=Window{4f2a1c u0 com.oculus.guardian/com.oculus.vrguardianservice.guardiandialog.GuardianDialogActivity}\n',
  'shell getprop ro.product.manufacturer': 'Oculus\n',
}

test('tells why a page on the device would draw no frames', async () => {
  const quest = await androidDisplayState(fakeAdb(QUEST_ASLEEP).run)
  assert.deepEqual(quest, {
    quest: true,
    awake: false,
    focus: 'com.oculus.guardian',
  })
  assert.equal(displayProblems(quest).length, 2)
  const phone = await androidDisplayState(
    fakeAdb({
      'shell dumpsys power': '  mWakefulness=Awake\n',
      'shell dumpsys window':
        '  mCurrentFocus=Window{9 u0 com.example.reader/com.example.reader.Main}\n',
      'shell getprop ro.product.manufacturer': 'Google\n',
      'shell pm path com.oculus.guardian': Error('not found'),
    }).run,
  )
  assert.deepEqual(phone, {
    quest: false,
    awake: true,
    focus: 'com.example.reader',
  })
  assert.deepEqual(displayProblems(phone), [])
})

test('keeps a Quest awake and puts the headset back as it was', async () => {
  for (const [previous, restored] of [
    ['\n', '0'],
    ['1\n', '1'],
  ]) {
    const adb = fakeAdb({
      'shell getprop debug.oculus.guardian_pause': previous,
      'shell am broadcast -a com.oculus.vrpowermanager.prox_close': '',
      'shell setprop debug.oculus.guardian_pause 1': '',
      [`shell setprop debug.oculus.guardian_pause ${restored}`]: '',
      'shell am broadcast -a com.oculus.vrpowermanager.automation_disable': '',
    })
    const awake = await keepQuestAwake(adb.run)
    assert.deepEqual(adb.calls.slice(1), [
      'shell am broadcast -a com.oculus.vrpowermanager.prox_close',
      'shell setprop debug.oculus.guardian_pause 1',
    ])
    await awake.restore()
    assert.deepEqual(adb.calls.slice(3), [
      `shell setprop debug.oculus.guardian_pause ${restored}`,
      'shell am broadcast -a com.oculus.vrpowermanager.automation_disable',
    ])
  }
})

test('says how to restore the headset by hand when adb cannot', async () => {
  const adb = fakeAdb({
    'shell getprop debug.oculus.guardian_pause': '\n',
    'shell am broadcast -a com.oculus.vrpowermanager.prox_close': '',
    'shell setprop debug.oculus.guardian_pause 1': '',
    'shell setprop debug.oculus.guardian_pause 0': Error('device offline'),
    'shell am broadcast -a com.oculus.vrpowermanager.automation_disable': '',
  })
  const awake = await keepQuestAwake(adb.run)
  await assert.rejects(
    awake.restore(),
    /device offline.*adb shell setprop debug\.oculus\.guardian_pause 0 and adb shell am broadcast/,
  )
  // A failed start leaves nothing changed behind it.
  const failing = fakeAdb({
    'shell getprop debug.oculus.guardian_pause': '\n',
    'shell am broadcast -a com.oculus.vrpowermanager.prox_close': '',
    'shell setprop debug.oculus.guardian_pause 1': Error('permission denied'),
    'shell setprop debug.oculus.guardian_pause 0': '',
    'shell am broadcast -a com.oculus.vrpowermanager.automation_disable': '',
  })
  await assert.rejects(keepQuestAwake(failing.run), /permission denied/)
  assert.ok(
    failing.calls.includes(
      'shell am broadcast -a com.oculus.vrpowermanager.automation_disable',
    ),
  )
})
