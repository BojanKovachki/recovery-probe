import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installIpcProbe } from '../../dist/ipc-probe.cjs'
import { observationConfig } from '../../dist/workflows/observe/config.mjs'
import { runObservation } from '../../dist/workflows/observe/capture.mjs'
import { ipcObservationAdapter } from '../../dist/workflows/observe/adapters.mjs'
import {
  summarizeRows,
  RowTracker,
} from '../../dist/workflows/observe/rows.mjs'
import {
  observationSummary,
  actionEffects,
  actionSummary,
  comparisonDigest,
} from '../../dist/workflows/observe/report.mjs'
import { selectorSpec } from '../../dist/workflows/observe/kit.mjs'

function hookFixture(options = {}) {
  const handlers = new Map(),
    sent = []
  const ipc = {
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
  }
  const proto = {
    send(channel, ...args) {
      sent.push([channel, ...args])
    },
  }
  const sender = Object.assign(Object.create(proto), {
    id: 1,
    mainFrame: {},
    isDestroyed: () => false,
    getURL: () => 'file:///synthetic.html',
  })
  const probe = installIpcProbe(ipc, {
    enabled: true,
    channels: ['fixture:invoke'],
    sender: () => sender,
    ...options,
  })
  ipc.handle('fixture:invoke', (_event, payload) =>
    Promise.resolve({ method: payload.method, secret: payload.secret }),
  )
  const call = (payload) =>
    handlers.get('fixture:invoke')(
      { sender, senderFrame: sender.mainFrame },
      payload,
    )
  return {
    probe,
    sender,
    proto,
    sent,
    call,
    control: { call: async (m, a) => probe[m](a) },
  }
}

test('the hook counts calls per method label without storing arguments; bad classifiers never affect calls', async () => {
  const f = hookFixture({
    classify: (_channel, [payload]) =>
      payload.method === 'explode'
        ? (() => {
            throw Error('x')
          })()
        : payload.method === 'bad label'
          ? 'not allowed!'
          : payload.method,
  })
  f.probe.begin({ id: 'observe', channel: 'fixture:invoke', observation: true })
  for (const method of ['read', 'read', 'noise', 'explode', 'bad label'])
    assert.equal(
      (await f.call({ method, secret: 'synthetic-private-argument' })).method,
      method,
    )
  const s = f.probe.snapshot()
  assert.equal(s.channels['fixture:invoke'].calls, 5)
  assert.equal(s.channels['fixture:invoke'].methods.read.successes, 2)
  assert.equal(s.channels['fixture:invoke'].methods.noise.calls, 1)
  assert.equal(s.channels['fixture:invoke'].methods.unclassified.calls, 2)
  assert.ok(!JSON.stringify(s).includes('synthetic-private-argument'))
  assert.equal(f.probe.identify().capabilities.methods, true)
})

test('push observation is scoped to the lease and target window, preserves sends and restores the prototype method', async () => {
  const f = hookFixture({
    pushChannels: ['fixture:emit'],
    classifyPush: (_channel, [payload]) => payload.event,
  })
  f.sender.send('fixture:emit', { event: 'before-lease' })
  const id = 'push'
  f.probe.begin({ id, channel: 'fixture:invoke', observation: true })
  assert.ok(Object.hasOwn(f.sender, 'send'))
  f.sender.send('fixture:emit', {
    event: 'queueChanged',
    payload: 'synthetic-private-payload',
  })
  f.sender.send('fixture:emit', { event: 'other' })
  f.sender.send('fixture:unwatched', { event: 'queueChanged' })
  const s = f.probe.snapshot()
  assert.equal(s.pushes['fixture:emit'].count, 2)
  assert.equal(s.pushes['fixture:emit'].methods.queueChanged.count, 1)
  assert.equal(s.pushes['fixture:unwatched'], undefined)
  assert.ok(!JSON.stringify(s).includes('synthetic-private-payload'))
  assert.equal(f.sent.length, 4, 'every send still reaches the original method')
  f.probe.reset(id)
  assert.equal(
    Object.hasOwn(f.sender, 'send'),
    false,
    'the instance wrapper is removed',
  )
  assert.equal(f.sender.send, f.proto.send)
  f.sender.send('fixture:emit', { event: 'after-lease' })
  assert.equal(f.probe.snapshot().pushes['fixture:emit'].count, 2)
  f.probe.begin({ id: 'fault', channel: 'fixture:invoke', fault: 'rejection' })
  assert.equal(
    Object.hasOwn(f.sender, 'send'),
    false,
    'fault plans never observe pushes',
  )
})

test('ending an observation restores a send wrapper the app installed earlier and leaves later wrappers alone', () => {
  const pushes = {
    pushChannels: ['fixture:emit'],
    classifyPush: (_channel, [payload]) => payload.event,
  }
  // The app wrapped send on the window before the observation, for example for tracing.
  const earlier = hookFixture(pushes)
  const traced = []
  const appWrapper = function (channel, ...args) {
    traced.push(channel)
    return earlier.proto.send.call(this, channel, ...args)
  }
  earlier.sender.send = appWrapper
  earlier.probe.begin({
    id: 'earlier',
    channel: 'fixture:invoke',
    observation: true,
  })
  assert.notEqual(earlier.sender.send, appWrapper)
  earlier.sender.send('fixture:emit', { event: 'queueChanged' })
  assert.deepEqual(
    traced,
    ['fixture:emit'],
    'the app wrapper still runs during the lease',
  )
  assert.equal(earlier.probe.snapshot().pushes['fixture:emit'].count, 1)
  earlier.probe.reset('earlier')
  assert.equal(
    earlier.sender.send,
    appWrapper,
    'the app wrapper is restored, not deleted',
  )
  earlier.sender.send('fixture:emit', { event: 'after' })
  assert.deepEqual(traced, ['fixture:emit', 'fixture:emit'])
  assert.equal(earlier.sent.length, 2)

  // Disposing the hook during a lease restores the app wrapper the same way.
  const disposed = hookFixture(pushes)
  disposed.sender.send = appWrapper
  disposed.probe.begin({
    id: 'dispose',
    channel: 'fixture:invoke',
    observation: true,
  })
  disposed.probe.dispose()
  assert.equal(disposed.sender.send, appWrapper)

  // A wrapper installed after ours is not removed; ours stays underneath as a pass-through.
  const later = hookFixture(pushes)
  later.probe.begin({
    id: 'later',
    channel: 'fixture:invoke',
    observation: true,
  })
  const ours = later.sender.send
  const laterWrapper = function (channel, ...args) {
    return ours.call(this, channel, ...args)
  }
  later.sender.send = laterWrapper
  later.probe.reset('later')
  assert.equal(later.sender.send, laterWrapper)
  later.sender.send('fixture:emit', { event: 'queueChanged' })
  assert.equal(
    later.sent.length,
    1,
    'sends still reach the original method once',
  )
  assert.equal(
    later.probe.snapshot().pushes['fixture:emit'].count,
    0,
    'nothing is counted after the lease',
  )
})

test('the observer requires hook capabilities for methods and data events before starting a plan', async () => {
  const base = {
    transport: 'ipc',
    channel: 'fixture:invoke',
    regionSelector: '#r',
    contentSelector: 'li',
  }
  const plain = hookFixture()
  await assert.rejects(
    ipcObservationAdapter(
      plain.control,
      observationConfig({ ...base, methods: ['read'] }),
      1,
    ).start(),
    /METHODS_UNSUPPORTED/,
  )
  await assert.rejects(
    ipcObservationAdapter(
      plain.control,
      observationConfig({ ...base, dataEvents: { channel: 'fixture:emit' } }),
      1,
    ).start(),
    /PUSHES_UNSUPPORTED/,
  )
  assert.equal(plain.probe.snapshot(), null, 'no plan was started')
})

test('observation config validates selectors, rows, actions, methods and data events', () => {
  const base = {
    transport: 'ipc',
    channel: 'fixture:invoke',
    regionSelector: '#r',
    contentSelector: { role: 'button', name: 'Move up' },
  }
  const c = observationConfig({
    ...base,
    methods: ['read'],
    dataEvents: { channel: 'fixture:emit', methods: ['queueChanged'] },
    rows: { selector: 'li', state: 'button', states: ['Pause'] },
    actions: [{ name: 'start', selector: { css: 'button', text: 'Start' } }],
  })
  assert.deepEqual(c.rows.aliases, {})
  assert.equal(c.lagThresholdMs, 2000)
  for (const bad of [
    { contentSelector: { name: 'x' } },
    { contentSelector: { role: 'Button!' } },
    { methods: ['bad label'] },
    { methods: [] },
    { rows: { selector: 'li', state: 'b', states: [] } },
    {
      rows: {
        selector: 'li',
        state: 'b',
        states: ['A'],
        aliases: { 'bad alias': 'x' },
      },
    },
    {
      actions: [
        { name: 'a', selector: 'b' },
        { name: 'a', selector: 'c' },
      ],
    },
    { dataEvents: { channel: '' } },
    { lagThresholdMs: 10 },
  ]) {
    assert.throws(
      () => observationConfig({ ...base, ...bad }),
      undefined,
      JSON.stringify(bad),
    )
  }
  const marked = observationConfig({
    ...base,
    rows: {
      selector: 'li',
      markers: { 'not installed': 'svg.status' },
      unexpected: ['not installed'],
    },
  })
  assert.deepEqual(marked.rows.states, [])
  assert.equal(marked.rows.state, undefined)
  assert.deepEqual(marked.rows.unexpected, ['not installed'])
  for (const rows of [
    { selector: 'li' },
    { selector: 'li', state: 'b' },
    { selector: 'li', states: ['A'] },
    { selector: 'li', markers: {} },
    { selector: 'li', markers: { A: 'svg' }, unexpected: ['B'] },
    { selector: 'li', markers: { A: 'svg' }, unexpected: [] },
    { selector: 'li', state: 'b', states: ['A'], markers: { A: 'svg' } },
    { selector: 'li', markers: { A: { name: 'x' } } },
    { selector: 'li', markers: { none: 'svg' } },
  ])
    assert.throws(
      () => observationConfig({ ...base, rows }),
      undefined,
      JSON.stringify(rows),
    )
  const http = {
    transport: 'http',
    endpoint: 'http://localhost/api',
    regionSelector: '#r',
    contentSelector: 'li',
  }
  assert.throws(
    () => observationConfig({ ...http, methods: ['read'] }),
    /only supported with IPC/,
  )
  assert.equal(selectorSpec('li', 'x'), 'li')
})

test('row summaries hash keys, apply aliases and keep only allowlisted states', () => {
  const rows = summarizeRows(
    {
      truncated: false,
      items: [
        { key: 'synthetic-private-name', state: 'Pause' },
        { key: 'synthetic-alias-name', state: 'Something else' },
        { key: 'synthetic-private-name', state: null },
      ],
    },
    { states: ['Pause'], aliases: { second: 'synthetic-alias-name' } },
  )
  assert.match(rows.items[0].row, /^key:[0-9a-f]{16}$/)
  assert.equal(rows.items[1].row, 'second')
  assert.equal(rows.items[1].state, 'other')
  assert.equal(rows.items[2].row, rows.items[0].row + '#2')
  assert.equal(rows.items[2].state, 'none')
  assert.ok(!JSON.stringify(rows).includes('synthetic-private'))
})

test('a matching marker names the row state before its text does', () => {
  const rows = summarizeRows(
    {
      truncated: false,
      items: [
        { key: 'a', state: 'Pause', marker: 1 },
        { key: 'b', state: 'Pause' },
        { key: 'c', state: null, marker: 0 },
        { key: 'd', state: null },
      ],
    },
    {
      states: ['Pause'],
      markers: { queued: 'svg.queued', 'not installed': 'svg.status' },
      aliases: {},
    },
  )
  assert.deepEqual(
    rows.items.map((item) => item.state),
    ['not installed', 'Pause', 'queued', 'none'],
  )
})

test('the row tracker reports each stretch of a row in an unexpected state once', () => {
  const t = new RowTracker({
    rows: {
      states: ['Pause'],
      markers: { 'not installed': 'svg' },
      unexpected: ['not installed'],
    },
    lagThresholdMs: 1000,
    minUnchangedReads: 2,
  })
  t.addActions([{ name: 'start', atMs: 250 }])
  const states = [
    'none',
    'not installed',
    'not installed',
    'not installed',
    'Pause',
    'not installed',
  ]
  states.forEach((state, i) => t.add(sample(i + 1, state, i)))
  // Another row in an allowed state never produces a finding.
  t.add({
    ...sample(7, 'Pause', 7),
    rows: { items: [{ row: 'x', state: 'Pause' }] },
  })
  // 'second' was missing from sample 7, so coming back starts a new finding.
  t.add(sample(8, 'not installed', 8))
  const findings = t.snapshot().findings
  assert.deepEqual(
    findings.map((f) => [f.code, f.row, f.state, f.samples]),
    [
      ['UNEXPECTED_ROW_STATE', 'second', 'not installed', 3],
      ['UNEXPECTED_ROW_STATE', 'second', 'not installed', 1],
      ['UNEXPECTED_ROW_STATE', 'second', 'not installed', 1],
    ],
  )
  const [first] = findings
  assert.deepEqual(first.firstSeenMs, [200, 250])
  assert.equal(first.lastSeenMs, 450)
  assert.equal(first.basis, 'CONFIGURED_UNEXPECTED_STATE')
  assert.deepEqual(first.afterAction, {
    name: 'start',
    atMs: 250,
    seenAfterActionMs: [0, 0],
  })
  assert.equal(
    first.summary,
    'Row ‘second’ showed not installed, which this region must not show, in 3 samples from 0.2–0.3 s to 0.5 s; first seen about 0.0 s after action ‘start’.',
  )
  assert.equal(findings[1].afterAction.name, 'start')
  // Marker states are tracked like text states.
  assert.deepEqual(
    t
      .snapshot()
      .rows.find((r) => r.row === 'second')
      .transitions.map((tr) => tr.to),
    ['not installed', 'Pause', 'not installed'],
  )
})

const trackerConfig = {
  rows: { states: ['Pause', 'Move up'] },
  lagThresholdMs: 1000,
  minUnchangedReads: 2,
}
const sample = (index, state, completed, data = null) => ({
  index,
  interval: 1,
  fromMs: index * 100,
  toMs: index * 100 + 50,
  rows: { items: [{ row: 'second', state }] },
  completed,
  data,
})

test('the row tracker reports a state that outlived completed reads and changed without a data event', () => {
  const t = new RowTracker(trackerConfig)
  t.addActions([{ name: 'start', atMs: 0 }])
  for (let i = 1; i <= 30; i++)
    t.add(
      sample(i, i < 30 ? 'Pause' : 'Move up', Math.floor(i / 4), {
        count: 1,
        lastAtMs: 120,
      }),
    )
  const [finding] = t.snapshot().findings
  assert.equal(finding.code, 'DELAYED_UI_UPDATE')
  assert.equal(finding.basis, 'NO_DATA_EVENT_BEFORE_UI_CHANGE')
  assert.equal(finding.confidence, 'medium')
  assert.equal(finding.unchangedReadCompletions, 7 - 0)
  assert.deepEqual(finding.afterAction.changedAfterActionMs, [2950, 3050])
  assert.equal(finding.previousStateStartedAfterActionMs, 100)
  assert.match(
    observationSummary(finding),
    /^Row ‘second’ stayed Pause for 2\.9 s across 7 completed selected reads, then changed to Move up; no data event arrived in the change window \(the last one was 2\.8 s earlier\)\. The change came 3\.0–3\.1 s after action ‘start’; the earlier state started right after it\.$/,
  )
})

test('a stale state that did not begin right after an action is only a low-confidence lead', () => {
  const t = new RowTracker(trackerConfig)
  t.addActions([{ name: 'start', atMs: 0 }])
  // The row first shows Move up, later switches to Pause on its own, then back after many reads.
  for (let i = 1; i <= 60; i++)
    t.add(
      sample(
        i,
        i < 20 ? 'Move up' : i < 60 ? 'Pause' : 'Move up',
        Math.floor(i / 4),
        { count: 1, lastAtMs: 120 },
      ),
    )
  const late = t.snapshot().findings.find((f) => f.from === 'Pause')
  assert.equal(late.confidence, 'low')
  assert.equal(late.previousStateStartedAfterActionMs, null)
  assert.match(
    observationSummary(late),
    /the earlier state did not start right after an action\.$/,
  )
})

test('the row tracker stays quiet when a data event explains the change, reads did not complete, or the row was not visible', () => {
  const cases = [
    [
      'data event in the change window',
      (i) =>
        sample(i, i < 30 ? 'Pause' : 'Move up', Math.floor(i / 4), {
          count: i < 30 ? 1 : 2,
          lastAtMs: i < 30 ? 120 : 2990,
        }),
    ],
    [
      'recent data event',
      (i) =>
        sample(i, i < 30 ? 'Pause' : 'Move up', Math.floor(i / 4), {
          count: 1,
          lastAtMs: 2500,
        }),
    ],
    [
      'too few completed reads',
      (i) => sample(i, i < 30 ? 'Pause' : 'Move up', 0, null),
    ],
    [
      'not consecutive',
      (i) => ({
        ...sample(i, i < 30 ? 'Pause' : 'Move up', Math.floor(i / 4), null),
        index: i === 30 ? 40 : i,
      }),
    ],
    [
      'state outside the allowlist',
      (i) => sample(i, i < 30 ? 'Pause' : 'other', Math.floor(i / 4), null),
    ],
  ]
  for (const [name, make] of cases) {
    const t = new RowTracker(trackerConfig)
    for (let i = 1; i <= 30; i++) t.add(make(i))
    assert.equal(t.snapshot().findings.length, 0, name)
  }
  const reads = new RowTracker(trackerConfig)
  for (let i = 1; i <= 30; i++)
    reads.add(sample(i, i < 30 ? 'Pause' : 'Move up', Math.floor(i / 4), null))
  assert.equal(reads.snapshot().findings[0].basis, 'UNCHANGED_ACROSS_READS')
  assert.equal(reads.snapshot().findings[0].confidence, 'low')
})

test('action effects link rows that appeared or changed after an action', () => {
  const report = {
    actions: [{ name: 'start', atMs: 1000, trusted: true }],
    rows: [
      {
        row: 'second',
        firstSeen: {
          fromMs: 1500,
          toMs: 1550,
          state: 'Pause',
          afterAction: { name: 'start', atMs: 1000 },
        },
        transitions: [
          {
            from: 'Pause',
            to: 'Move up',
            afterMs: 3900,
            byMs: 4050,
            afterAction: { name: 'start', atMs: 1000 },
          },
        ],
      },
      {
        row: 'key:0123456789abcdef',
        firstSeen: {
          fromMs: 100,
          toMs: 150,
          state: 'Pause',
          afterAction: null,
        },
        transitions: [
          {
            from: 'Pause',
            to: 'Move up',
            afterMs: 1200,
            byMs: 1300,
            afterAction: { name: 'start', atMs: 1000 },
          },
        ],
      },
    ],
  }
  report.rows.push({
    row: 'key:fedcba9876543210',
    firstSeen: {
      fromMs: 1500,
      toMs: 1550,
      state: 'none',
      afterAction: { name: 'start', atMs: 1000 },
    },
    transitions: [],
  })
  const [effect] = actionEffects(report)
  assert.equal(
    actionSummary(effect),
    'Action ‘start’ at 1.0 s (trusted input): row ‘second’ appeared 0.5–0.6 s later as Pause, then Pause → Move up 2.9–3.1 s after the action; row 01234567 changed Pause → Move up 0.2–0.3 s after the action; 1 row without a tracked state appeared.',
  )
})

test('busy targets omit per-completion comparisons and the terminal digest groups comparisons', async () => {
  const row = {
    calls: 0,
    successes: 0,
    errors: 0,
    pending: 0,
    lastReadAt: null,
    lastCompletedAt: null,
  }
  const abort = new AbortController()
  let n = 0
  const page = {
    on() {},
    off() {},
    async evaluate(fn) {
      return fn.name === 'readRegion'
        ? {
            presence: 'visible',
            contentCount: 1,
            content: { texts: [String(n % 2)], truncated: false },
            visible: true,
            online: true,
            actions: [],
          }
        : true
    },
  }
  const adapter = {
    async start() {},
    async snapshot() {
      return { channels: { 'fixture:invoke': { ...row } } }
    },
    async stop() {},
  }
  const report = await runObservation(
    page,
    {
      transport: 'ipc',
      channel: 'fixture:invoke',
      regionSelector: '#r',
      contentSelector: 'li',
      observationMs: 500,
    },
    adapter,
    {
      signal: abort.signal,
      onSample() {
        n++
        row.calls += 5
        row.successes += 5
        if (n === 6) abort.abort()
      },
    },
  )
  assert.equal(
    report.comparisons.filter((c) => c.basis === 'READ_COMPLETION').length,
    0,
  )
  assert.equal(report.notes[0].code, 'READ_COMPLETION_COMPARISONS_OMITTED')
  assert.deepEqual(
    comparisonDigest({
      comparisons: [
        { interval: 1, basis: 'READ_COMPLETION', result: 'unchanged' },
        { interval: 1, basis: 'READ_COMPLETION', result: 'unchanged' },
        {
          interval: 2,
          basis: 'INTERVAL_RETURN',
          result: 'changed',
          followUp: { firstBaselineMatch: {} },
        },
      ],
    }),
    [
      'Interval 1 comparisons: 2 read-completion unchanged.',
      'Interval 2 comparisons: 1 interval-return changed (later matched).',
    ],
  )
})

test('a mark from the operator opens an interval; a failing operator is reported as incomplete coverage', async () => {
  const row = {
    calls: 0,
    successes: 0,
    errors: 0,
    pending: 0,
    lastReadAt: null,
    lastCompletedAt: null,
  }
  const page = {
    on() {},
    off() {},
    async evaluate(fn) {
      return fn.name === 'readRegion'
        ? {
            presence: 'absent',
            contentCount: 0,
            visible: true,
            online: true,
            actions: [],
          }
        : true
    },
  }
  const adapter = {
    async start() {},
    async snapshot() {
      return { channels: { 'fixture:invoke': { ...row } } }
    },
    async stop() {},
  }
  const report = await runObservation(
    page,
    {
      transport: 'ipc',
      channel: 'fixture:invoke',
      regionSelector: '#r',
      contentSelector: 'li',
      observationMs: 600,
    },
    adapter,
    {
      async operator({ mark }) {
        const index = await mark()
        assert.equal(index, 2)
        throw Error('synthetic step failure')
      },
    },
  )
  assert.equal(report.intervals.length, 2)
  assert.equal(report.operator.status, 'failed')
  assert.ok(report.coverage.gaps.includes('OPERATOR_STEPS_INCOMPLETE'))
  assert.equal(report.captureComplete, false)
})
