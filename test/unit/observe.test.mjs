import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  observationConfig,
  ipcObservationAdapter,
  runObservation,
} from '../../dist/workflows/observe/run.mjs'
import { installIpcProbe } from '../../dist/ipc-probe.cjs'

function fixture() {
  let listener, complete
  const ipc = {
    handle(channel, fn) {
      listener = fn
    },
  }
  const sender = {
    id: 1,
    mainFrame: {},
    isDestroyed: () => false,
    getURL: () => 'file:///synthetic.html',
  }
  const probe = installIpcProbe(ipc, {
    enabled: true,
    channels: ['fixture:read'],
    sender: () => sender,
  })
  ipc.handle(
    'fixture:read',
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const control = { call: async (method, arg) => probe[method](arg) }
  return {
    probe,
    control,
    call: () => listener({ sender, senderFrame: sender.mainFrame }),
    complete: () => complete('value'),
  }
}
const c = { channel: 'fixture:read', observationMs: 500 }
test('observation config rejects mutation options and requires explicit content evidence', () => {
  const input = {
    transport: 'http',
    endpoint: 'http://localhost/api/items',
    regionSelector: '#items',
    contentSelector: 'li',
  }
  assert.equal(observationConfig(input).observationMs, 30000)
  assert.equal(observationConfig(input).detail, 'content')
  assert.equal(
    observationConfig({ ...input, detail: 'region' }).detail,
    'region',
  )
  assert.throws(() => observationConfig({ ...input, detail: 'auto' }), /detail/)
  for (const extra of [
    { reload: true },
    { fault: 'rejection' },
    { observationMs: 0 },
    { contentSelector: '' },
    { endpoint: 'http://localhost/api/items?token=secret' },
    { cdp: 'http://remote.example:9222' },
  ])
    assert.throws(() => observationConfig({ ...input, ...extra }))
})
test('fault-free IPC observation tracks starts and settlements, preserves promises, and stops without clearing UI state', async () => {
  const f = fixture()
  const a = ipcObservationAdapter(f.control, c, 1)
  await a.start()
  assert.equal(a.metadata().version, f.probe.identify().version)
  assert.equal(a.metadata().runtime.node, process.versions.node)
  assert.equal('pageUrl' in a.metadata(), false)
  const pending = f.call()
  const started = await a.snapshot()
  assert.equal(started.channels[c.channel].pending, 1)
  assert.ok(started.channels[c.channel].firstReadAt >= started.startedAt)
  assert.equal(started.channels[c.channel].lastCompletedAt, null)
  assert.throws(
    () =>
      f.probe.begin({ id: 'foreign', channel: c.channel, fault: 'rejection' }),
    /ALREADY_ACTIVE/,
  )
  f.complete()
  await pending
  const ended = await a.snapshot()
  assert.equal(ended.channels[c.channel].successes, 1)
  assert.ok(
    ended.channels[c.channel].lastCompletedAt >=
      ended.channels[c.channel].lastReadAt,
  )
  const cleanup = await a.stop()
  assert.equal(cleanup.verified, true)
  assert.equal(cleanup.runId, started.id)
  assert.equal(cleanup.observingUntil, null)
  assert.equal(cleanup.injected, 0)
  assert.equal(f.probe.snapshot().observingUntil, null)
  const unobserved = f.call()
  f.complete()
  await unobserved
  assert.equal(f.probe.snapshot().channels[c.channel].calls, 1)
})
test('lost observation begin reply is cleaned up; foreign fault and observation plans are never replaced', async () => {
  const f = fixture()
  const unreliable = {
    async call(method, arg) {
      const value = await f.control.call(method, arg)
      if (method === 'begin') throw Error('lost reply')
      return value
    },
  }
  const a = ipcObservationAdapter(unreliable, c, 1)
  await assert.rejects(a.start(), /lost reply/)
  await a.stop()
  assert.equal(f.probe.snapshot().observingUntil, null)
  for (const plan of [{ fault: 'rejection' }, { observation: true }]) {
    const id = JSON.stringify(plan)
    f.probe.begin({ id, channel: c.channel, ...plan })
    const foreign = ipcObservationAdapter(f.control, c, 1)
    await assert.rejects(foreign.start(), /ALREADY_ACTIVE/)
    await foreign.stop()
    assert.equal(f.probe.snapshot().id, id)
    assert.ok(f.probe.snapshot().armed || f.probe.snapshot().observingUntil)
    // Atomic check also protects against a plan started between preflight and begin.
    assert.throws(
      () =>
        f.probe.begin({
          id: 'racing-' + id,
          channel: c.channel,
          observation: true,
        }),
      /ALREADY_ACTIVE/,
    )
    f.probe.reset(id)
  }
})
test('observation rejects faults and expires its lease; unsupported hooks fail before mutation', async () => {
  const f = fixture()
  assert.throws(
    () =>
      f.probe.begin({
        id: 'bad',
        channel: c.channel,
        observation: true,
        fault: 'rejection',
      }),
    /fault-free/,
  )
  f.probe.begin({
    id: 'expire',
    channel: c.channel,
    observation: true,
    ttlMs: 100,
  })
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(f.probe.snapshot().observingUntil, null)
  const calls = []
  const old = ipcObservationAdapter(
    {
      async call(method) {
        calls.push(method)
        return { senderId: 1, capabilities: {} }
      },
    },
    c,
    1,
  )
  await assert.rejects(old.start(), /UNSUPPORTED/)
  await old.stop()
  assert.deepEqual(calls, ['identify'])
})

test(
  'an unresponsive renderer does not trap observation or prevent owned cleanup',
  { timeout: 10000 },
  async () => {
    for (const interrupt of [false, true]) {
      let evaluations = 0,
        stopped = false
      const abort = new AbortController()
      const page = {
        on() {},
        off() {},
        evaluate() {
          if (++evaluations === 1) return Promise.resolve() // CSS validation.
          if (interrupt) abort.abort()
          return new Promise(() => {}) // A blocked renderer never answers the UI read.
        },
      }
      const row = {
        calls: 0,
        successes: 0,
        errors: 0,
        pending: 0,
        lastReadAt: null,
        lastCompletedAt: null,
      }
      const adapter = {
        async start() {},
        async snapshot() {
          return { channels: { 'fixture:read': row } }
        },
        async stop() {
          stopped = true
        },
      }
      const report = await runObservation(
        page,
        {
          transport: 'ipc',
          channel: 'fixture:read',
          regionSelector: '#data',
          contentSelector: 'li',
          observationMs: 500,
        },
        adapter,
        { signal: abort.signal },
      )
      assert.equal(report.sampling.completedSamples, 0)
      assert.equal(report.sampling.startToStart.meanMs, null)
      assert.ok(report.metadata.recoveryProbeVersion)
      assert.equal(stopped, true)
      assert.equal(report.cleanup, 'complete')
      assert.equal(report.captureComplete, false)
      assert.equal(report.status, interrupt ? 'interrupted' : 'incomplete')
      if (!interrupt) assert.match(report.error, /UI_SAMPLE_TIMEOUT/)
    }
  },
)

test('the operator interval acknowledgement follows its read-counter boundary', async () => {
  const row = {
    calls: 0,
    successes: 0,
    errors: 0,
    pending: 0,
    lastReadAt: null,
    lastCompletedAt: null,
  }
  const abort = new AbortController()
  let announced = false,
    marker = true
  const page = {
    on() {},
    off() {},
    async evaluate() {
      return {
        presence: 'absent',
        contentCount: 0,
        visible: true,
        online: true,
      }
    },
  }
  const adapter = {
    async start() {},
    async snapshot() {
      return { channels: { 'fixture:read': { ...row } } }
    },
    async stop() {},
  }
  const report = await runObservation(
    page,
    {
      transport: 'ipc',
      channel: 'fixture:read',
      regionSelector: '#data',
      contentSelector: 'li',
      observationMs: 500,
    },
    adapter,
    {
      signal: abort.signal,
      takeMarker() {
        const value = marker
        marker = false
        return value
      },
      onInterval() {
        announced = true
        row.calls++
        row.successes++
      }, // Immediate action on the acknowledgement.
      onSample() {
        abort.abort()
      },
    },
  )
  assert.equal(announced, true)
  assert.equal(report.intervals[0].reads.calls, 0)
  assert.equal(report.intervals[1].reads.calls, 1)
})

// preview.12 hooks support observation but do not expose version/runtime metadata.
test('older observation-capable hooks retain coverage with unknown provenance', async () => {
  const f = fixture()
  const control = {
    async call(method, arg) {
      const value = await f.control.call(method, arg)
      if (method === 'identify') {
        delete value.version
        delete value.runtime
      }
      return value
    },
  }
  const adapter = ipcObservationAdapter(control, c, 1)
  await adapter.start()
  assert.equal(adapter.metadata().version, null)
  assert.equal(adapter.metadata().runtime.electron, null)
  assert.equal((await adapter.snapshot()).injected, 0)
  await adapter.stop()
})

test('cleanup evidence is not returned when the readback still shows an active lease', async () => {
  const f = fixture()
  let reset = false
  const control = {
    async call(method, arg) {
      if (method === 'reset') {
        reset = true
        return
      } // Simulate an acknowledged but ineffective reset.
      return f.control.call(method, arg)
    },
  }
  const adapter = ipcObservationAdapter(control, c, 1)
  await adapter.start()
  try {
    await assert.rejects(adapter.stop(), /CLEANUP_UNVERIFIED/)
    assert.equal(reset, true)
  } finally {
    f.probe.reset(f.probe.snapshot().id)
  }
})
