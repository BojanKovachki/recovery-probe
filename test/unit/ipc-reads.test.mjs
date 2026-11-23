import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverIpcReads } from '../../dist/workflows/reads.mjs'
import { fake } from '../helpers/fake.mjs'

const row = (calls, firstReadAt, extra = {}) => ({
  calls,
  successes: calls,
  errors: 0,
  pending: 0,
  firstReadAt,
  realCalls: calls,
  ...extra,
})

/**
 * A hook that observes one run like the real one: no state before `begin`,
 * the given channel counters while observing, and a clean state after `reset`.
 */
function hook(channels, { lose = false } = {}) {
  const calls = []
  let state = null
  /** @type {import('../../dist/transports/ipc/inspector.mjs').IpcInspector} */
  const control = fake({
    async call(method, arg) {
      calls.push([method, arg])
      if (method === 'begin')
        state = { id: arg.id, senderId: 7, observation: true }
      if (method === 'reset') state = { ...state, observingUntil: null }
      if (method !== 'snapshot' || !state) return state
      const observing = state.observingUntil !== null && !lose
      return {
        ...state,
        observingUntil: observing ? Date.now() + 1000 : null,
        armed: null,
        injected: 0,
        channels,
      }
    },
  })
  return { control, calls }
}

/** @type {import('playwright').Page} */
const page = fake({
  async reload() {},
  url: () => 'http://localhost:3000/app?user=1#/orders',
})
/** @type {import('../../dist/ipc-probe.cjs').IpcIdentity} */
const identity = fake({
  senderId: 7,
  registered: ['app:read', 'app:write', 'bridge:invoke', 'app:settings'],
})

test('IPC reads list the called channels in order, with method labels only where they mean something', async () => {
  const { control, calls } = hook({
    'app:read': row(2, 300, {
      methods: { unclassified: row(2, 300) },
    }),
    'app:write': row(0, null),
    'bridge:invoke': row(3, 100, {
      errors: 1,
      methods: {
        'Session.Refresh': row(2, 100),
        'Catalog.Search': row(1, 150),
        unclassified: row(0, null),
      },
    }),
    'app:settings': row(1, 200),
  })
  const reads = await discoverIpcReads(page, control, identity, {
    durationMs: 200,
  })
  assert.deepEqual(reads.channels, [
    {
      channel: 'bridge:invoke',
      calls: 3,
      errors: 1,
      methods: { 'Session.Refresh': 2, 'Catalog.Search': 1 },
    },
    { channel: 'app:settings', calls: 1, errors: 0 },
    { channel: 'app:read', calls: 2, errors: 0 },
  ])
  assert.equal(reads.pageUrl, 'http://localhost:3000/app')
  const [, begin] = calls.find(([method]) => method === 'begin')
  assert.deepEqual(
    {
      channel: begin.channel,
      requiredChannels: begin.requiredChannels,
      observation: begin.observation,
      fault: begin.fault,
    },
    {
      channel: 'app:read',
      requiredChannels: ['app:write', 'bridge:invoke', 'app:settings'],
      observation: true,
      fault: undefined,
    },
  )
  assert.deepEqual(
    calls.find(([method]) => method === 'reset'),
    ['reset', begin.id],
  )
})

test('IPC reads follow the order of first calls the hook numbered, even when their times tie', async () => {
  const { control } = hook({
    'app:read': row(1, 100, { firstReadOrder: 2 }),
    'app:write': row(0, null, { firstReadOrder: null }),
    'bridge:invoke': row(1, 100, { firstReadOrder: 1 }),
  })
  const reads = await discoverIpcReads(page, control, identity, {
    durationMs: 200,
  })
  assert.deepEqual(
    reads.channels.map(({ channel }) => channel),
    ['bridge:invoke', 'app:read'],
  )
})

test('IPC reads end the observation and fail when its coverage was lost', async () => {
  const { control, calls } = hook({ 'app:read': row(1, 100) }, { lose: true })
  await assert.rejects(
    discoverIpcReads(page, control, identity, { durationMs: 200 }),
    /IPC_OBSERVATION_COVERAGE_LOST/,
  )
  assert.ok(calls.some(([method]) => method === 'reset'))
})

test('IPC reads refuse to start beside another plan, or without captured channels', async () => {
  /** @type {import('../../dist/transports/ipc/inspector.mjs').IpcInspector} */
  const busy = fake({
    call: async (method) =>
      method === 'snapshot' ? { observingUntil: Date.now() + 1000 } : null,
  })
  await assert.rejects(
    discoverIpcReads(page, busy, identity, { durationMs: 200 }),
    /IPC_PLAN_ALREADY_ACTIVE/,
  )
  const { control } = hook({})
  await assert.rejects(
    discoverIpcReads(page, control, fake({ senderId: 7, registered: [] }), {
      durationMs: 200,
    }),
    /hasn't captured any channel/,
  )
})
