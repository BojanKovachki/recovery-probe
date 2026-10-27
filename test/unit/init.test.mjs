import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseIpcScenario, detectTarget } from '../../dist/tools/init.mjs'
import { fake } from '../helpers/fake.mjs'

/** @type {import('../../dist/ipc-probe.cjs').IpcIdentity} */
const identity = fake({
  version: '0.0.0',
  channels: ['files:read', 'files:versions', 'files:thumbnails', 'unused'],
  registered: ['files:read', 'files:versions', 'files:thumbnails'],
})

// Answers questions from a script and keeps what was printed.
function scripted(answers) {
  const printed = []
  return {
    printed,
    io: {
      interactive: true,
      log: (text) => printed.push(text),
      ask: async (prompt) => {
        printed.push(prompt)
        if (!answers.length) throw new Error(`Unexpected question: ${prompt}`)
        return answers.shift()
      },
    },
  }
}

test('init tests a URL, an attached app, or an app with the IPC hook', async () => {
  /** @param {{ version?: object, list?: object[], hook?: object }} found */
  const probes = ({ version, list, hook }) => ({
    json: async (url) =>
      url.endsWith('/json/version')
        ? version
        : url.endsWith('/json/list')
          ? list
          : null,
    identify: async () => hook,
  })
  assert.deepEqual(
    await detectTarget({ url: 'http://localhost:3000' }, probes({})),
    { kind: 'web', url: 'http://localhost:3000' },
  )
  assert.deepEqual(await detectTarget({}, probes({})), { kind: 'none' })
  assert.deepEqual(await detectTarget({}, probes({ version: {} })), {
    kind: 'desktop',
    cdp: 'http://127.0.0.1:9222',
  })
  assert.deepEqual(
    await detectTarget(
      { cdp: 'http://127.0.0.1:9333' },
      probes({ version: {}, list: [], hook: { error: 'not loaded' } }),
    ),
    { kind: 'desktop', cdp: 'http://127.0.0.1:9333', hookError: 'not loaded' },
  )
  assert.deepEqual(
    await detectTarget(
      {},
      probes({ version: {}, list: [], hook: { identity } }),
    ),
    {
      kind: 'ipc',
      cdp: 'http://127.0.0.1:9222',
      inspector: 'http://127.0.0.1:9229',
      identity,
    },
  )
})

test('init asks for the channel behind the screen and the ones it needs', async () => {
  const where = {
    cdp: 'http://127.0.0.1:9222',
    inspector: 'http://127.0.0.1:9229',
  }
  const { io, printed } = scripted(['2', 'x', '2, 1, 2'])
  assert.deepEqual(await chooseIpcScenario(identity, io, where), {
    channel: 'files:versions',
    requiredChannels: ['files:thumbnails', 'files:read'],
    ...where,
  })
  assert.ok(
    printed.includes('Enter numbers from the list, separated by commas.'),
  )
  const single = scripted([])
  assert.deepEqual(
    await chooseIpcScenario(
      { ...identity, registered: ['files:read'] },
      single.io,
      where,
    ),
    { channel: 'files:read', requiredChannels: [], ...where },
  )
  await assert.rejects(
    chooseIpcScenario({ ...identity, registered: [] }, scripted([]).io, where),
    /hasn't registered any of the hook's channels/,
  )
})
