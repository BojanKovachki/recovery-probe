import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  androidDevices,
  androidDevtoolsTargets,
  forwardAndroidDevtools,
  parseDevtoolsSockets,
  parseProcesses,
  defaultAdbPath,
} from '../dist/android.mjs'

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
    { fetchVersion: async (url) => (versions.push(url), { ok: true }) },
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
