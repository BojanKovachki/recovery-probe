import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachIpcWindow } from '../../dist/targets/ipc-window.mjs'
import { reportFolder } from '../../dist/reports/folder.mjs'
import { fake } from '../helpers/fake.mjs'

// Pages that run their evaluate callbacks here, and a hook that checks the challenge.
const page = (url) => ({ url: () => url, evaluate: async (fn, arg) => fn(arg) })
/** @returns {import('playwright').Browser} */
const browser = (...pages) => fake({ contexts: () => [{ pages: () => pages }] })
const hook = (identity) => {
  const calls = []
  /** @type {import('../../dist/transports/ipc/inspector.mjs').IpcInspector} */
  const control = fake({
    async call(method, challenge) {
      calls.push(challenge)
      if (challenge && globalThis.__recoveryProbeWindowNonce !== challenge)
        throw new Error('Not the same window')
      return identity
    },
  })
  return { control, calls }
}
const identity = {
  pageUrl: 'file:///app.html',
  registered: ['files:read'],
  senderId: 1,
}

test('the hook window is found once, proven with a challenge and left clean', async () => {
  const target = page('file:///app.html')
  const { control, calls } = hook(identity)
  const attached = await attachIpcWindow(
    browser(page('file:///other.html'), target),
    control,
    ['files:read'],
  )
  assert.equal(attached.page, target)
  assert.equal(attached.identity, identity)
  assert.match(calls[1], /^[0-9a-f-]{36}$/)
  assert.equal(Object.hasOwn(globalThis, '__recoveryProbeWindowNonce'), false)
})

test('a channel the hook did not capture, or no single window, stops the attach', async () => {
  await assert.rejects(
    attachIpcWindow(browser(page(identity.pageUrl)), hook(identity).control, [
      'files:read',
      'files:write',
    ]),
    /didn't capture files:write/,
  )
  for (const pages of [[], [page(identity.pageUrl), page(identity.pageUrl)]])
    await assert.rejects(
      attachIpcWindow(browser(...pages), hook(identity).control, [
        'files:read',
      ]),
      /exactly one window/,
    )
})

test('report folders are new, private and ignored by git', async (t) => {
  const cwd = process.cwd()
  const dir = await mkdtemp(join(tmpdir(), 'rp-folder-'))
  t.after(async () => {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  })
  process.chdir(dir)
  const made = await reportFolder('ipc')
  assert.match(made, /[\\/]\.recovery-probe[\\/]ipc-\w+$/)
  assert.equal(await readFile(join(made, '.gitignore'), 'utf8'), '*\n')
  const out = await reportFolder('ipc', join('runs', 'first'))
  assert.ok((await stat(out)).isDirectory())
  await assert.rejects(reportFolder('ipc', join('runs', 'first')), /EEXIST/)
})
