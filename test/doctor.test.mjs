import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { freePort } from './repair-fixture.mjs'
import { IPC_HOOK_PATH, runDoctor } from '../dist/doctor.mjs'

const cli = fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url))
const unused = async () => `http://127.0.0.1:${await freePort()}`
const check = (report, prefix) =>
  report.checks.find((c) => c.name.startsWith(prefix))

// A Node process with an inspector, running `main` as its program.
async function inspected(t, main) {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    [`--inspect=127.0.0.1:${port}`, '-e', main],
    { stdio: 'ignore' },
  )
  t.after(() => child.kill())
  const inspector = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    const ready = await fetch(`${inspector}/json/list`).then(
      (r) => r.ok,
      () => false,
    )
    if (ready) return inspector
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('The inspector did not start')
}

test('with nothing running, only optional parts are missing', async () => {
  const report = await runDoctor({
    cdp: await unused(),
    inspector: await unused(),
  })
  assert.equal(report.ok, true)
  assert.equal(check(report, 'Node.js').status, 'ok')
  assert.equal(check(report, 'Playwright').status, 'ok')
  assert.equal(check(report, 'App on').status, 'missing')
  assert.match(check(report, 'App on').fix, /--remote-debugging-port=9222/)
  assert.equal(check(report, 'IPC hook').status, 'missing')
  assert.ok(check(report, 'IPC hook').fix.includes(IPC_HOOK_PATH))
  await assert.rejects(
    runDoctor({ cdp: 'http://192.0.2.1:9222' }),
    /not a loopback address/,
  )
})

test('an Electron app on the debugging port is named with its windows', async (t) => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify(
        request.url === '/json/version'
          ? { Browser: 'Chrome/122.0', 'User-Agent': 'Mozilla Electron/29.0.1' }
          : [{ type: 'page' }, { type: 'service_worker' }],
      ),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const report = await runDoctor({
    cdp: `http://127.0.0.1:${server.address().port}`,
    inspector: await unused(),
  })
  assert.equal(check(report, 'App on').status, 'ok')
  assert.equal(check(report, 'App on').detail, 'Electron 29.0.1, 1 window')
})

test('an inspector without the hook is a problem with the setup as the fix', async (t) => {
  const inspector = await inspected(t, 'setInterval(() => {}, 1000)')
  const report = await runDoctor({ cdp: await unused(), inspector })
  assert.equal(report.ok, false)
  const ipc = check(report, 'IPC hook')
  assert.equal(ipc.status, 'problem')
  assert.match(ipc.detail, /hook isn't loaded/)
  assert.match(ipc.fix, /installIpcProbe/)
  assert.ok(ipc.fix.includes(IPC_HOOK_PATH))
})

test('the loaded hook reports the channels it can fail', async (t) => {
  const inspector = await inspected(
    t,
    `const { installIpcProbe } = require(${JSON.stringify(IPC_HOOK_PATH)})
const ipcMain = { handle() {} }
const contents = { id: 1, isDestroyed: () => false, getURL: () => 'file:///app.html' }
globalThis.__recoveryProbeIpc = installIpcProbe(ipcMain, {
  enabled: true,
  channels: ['files:read', 'files:versions', 'files:unused'],
  sender: () => contents,
})
for (const channel of ['files:read', 'files:versions', 'contacts:invite'])
  ipcMain.handle(channel, async () => [])
setInterval(() => {}, 1000)`,
  )
  const report = await runDoctor({ cdp: await unused(), inspector })
  assert.equal(check(report, 'IPC hook').status, 'ok', JSON.stringify(report))
  assert.equal(
    check(report, 'IPC hook').detail,
    `${report.version}, 2 channels to test; never registered: files:unused`,
  )
  assert.match(check(report, 'IPC hook').fix, /before the app registers/)
  assert.deepEqual(report.ipc.channels, [
    'files:read',
    'files:versions',
    'files:unused',
  ])
  assert.deepEqual(report.ipc.registered, ['files:read', 'files:versions'])
})

test('a hook from another version must be reloaded', async (t) => {
  const inspector = await inspected(
    t,
    `globalThis.__recoveryProbeIpc = { identify: () => ({ version: '0.0.1', registered: [] }) }
setInterval(() => {}, 1000)`,
  )
  const report = await runDoctor({ cdp: await unused(), inspector })
  const ipc = check(report, 'IPC hook')
  assert.equal(ipc.status, 'problem')
  assert.match(ipc.detail, /hook from 0\.0\.1/)
  assert.ok(ipc.fix.includes(IPC_HOOK_PATH))
})

test('with nothing running, doctor passes and init says how to start', async () => {
  const run = promisify(execFile)
  const doctor = await run(process.execPath, [
    cli,
    'doctor',
    '--json',
    '--cdp',
    await unused(),
    '--inspector',
    await unused(),
  ])
  assert.equal(JSON.parse(doctor.stdout).ok, true)
  const init = await run(process.execPath, [
    cli,
    'init',
    '--cdp',
    await unused(),
  ]).then(
    () => assert.fail('init should exit with 2'),
    (error) => error,
  )
  assert.equal(init.code, 2)
  assert.match(init.stdout, /Nothing to test yet/)
})
