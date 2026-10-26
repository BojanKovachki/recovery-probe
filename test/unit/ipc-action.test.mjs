import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installIpcProbe } from '../../dist/ipc-probe.cjs'
import { actionConfig } from '../../dist/workflows/action/config.mjs'
import { classifyActionRuns } from '../../dist/workflows/action/classify.mjs'
import { observationSteps } from '../../dist/workflows/observe/steps.mjs'

function hook() {
  const handlers = new Map()
  const ipc = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }
  const sender = {
    id: 1,
    mainFrame: {},
    isDestroyed: () => false,
    getURL: () => 'file:///fixture.html#/contacts',
  }
  const probe = installIpcProbe(ipc, {
    enabled: true,
    channels: ['write'],
    sender: () => sender,
  })
  ipc.handle('write', () => Promise.resolve('written'))
  const call = () =>
    handlers.get('write')({ sender, senderFrame: sender.mainFrame }, 'value')
  return { probe, call }
}

test('injected results can settle after a simulated latency', async () => {
  const { probe, call } = hook()
  assert.equal(probe.identify().capabilities.faultDelay, true)
  probe.begin({
    id: 'slow',
    channel: 'write',
    fault: 'rejection',
    delayMs: 120,
  })
  assert.equal(probe.snapshot().armed.delayMs, 120)
  const started = Date.now()
  await assert.rejects(call(), /injected IPC rejection/)
  assert.ok(Date.now() - started >= 100)
  probe.begin({
    id: 'slow-null',
    channel: 'write',
    fault: 'null-result',
    delayMs: 50,
  })
  assert.equal(await call(), null)
  assert.equal(probe.snapshot().channels.write.realCalls, 0)
  probe.begin({ id: 'instant', channel: 'write', fault: 'rejection' })
  assert.equal(probe.snapshot().armed.delayMs, 0)
  for (const [id, options, message] of [
    ['no-fault', { delayMs: 10 }, /needs a fault/],
    ['too-long', { fault: 'rejection', delayMs: 10001 }, /0–10000/],
    ['fraction', { fault: 'rejection', delayMs: 1.5 }, /0–10000/],
    ['observation', { observation: true, delayMs: 10 }, /needs a fault/],
  ])
    assert.throws(
      () => probe.begin({ id, channel: 'write', ...options }),
      message,
    )
  probe.reset('instant')
})

test('action config requires a channel and an action, and rejects unknown options', () => {
  const config = actionConfig({ channel: 'write', action: '#send' })
  assert.deepEqual(
    {
      setup: config.setup,
      latencyMs: config.latencyMs,
      observationMs: config.observationMs,
      sampleMs: config.sampleMs,
      restoreWindow: config.restoreWindow,
    },
    {
      setup: [],
      latencyMs: 400,
      observationMs: 6000,
      sampleMs: 100,
      restoreWindow: false,
    },
  )
  for (const [input, message] of [
    [null, /must be an object/],
    [{ action: '#send' }, /channel is required/],
    [{ channel: 'write' }, /action/],
    [
      { channel: 'write', action: '#send', fault: 'x' },
      /Unsupported action option: fault/,
    ],
    [
      { channel: 'write', action: '#send', latencyMs: 5001 },
      /latencyMs must be 0–5000/,
    ],
    [
      { channel: 'write', action: '#send', observationMs: 500 },
      /observationMs must be 1000–30000/,
    ],
    [
      { channel: 'write', action: '#send', setup: [{ fill: '#email' }] },
      /value must be text/,
    ],
    [
      { channel: 'write', action: '#send', setup: [{ expect: '#sent' }] },
      /setup steps cannot use expect/,
    ],
    [
      { channel: 'write', action: '#send', regionSelector: ' ' },
      /regionSelector/,
    ],
  ])
    assert.throws(() => actionConfig(input), message)
})

test('fill and press steps validate their argument', () => {
  assert.deepEqual(
    observationSteps([
      { fill: '#email', value: 'someone@example.invalid', name: 'type-email' },
      { press: '#email', key: 'Enter' },
    ]),
    [
      {
        kind: 'fill',
        target: '#email',
        value: 'someone@example.invalid',
        timeoutMs: 10000,
        name: 'type-email',
      },
      { kind: 'press', target: '#email', key: 'Enter', timeoutMs: 10000 },
    ],
  )
  for (const [step, message] of [
    [{ fill: '#email', value: 7 }, /value must be text/],
    [{ fill: '#email', value: 'x'.repeat(1001) }, /value must be text/],
    [{ press: '#email', key: 'Enter key' }, /key must be a key name/],
    [{ press: '#email' }, /key must be a key name/],
    [{ click: '#send', value: 'x' }, /Unsupported steps\[0\] property: value/],
    [
      { fill: '#email', value: 'x', key: 'Enter' },
      /Unsupported steps\[0\] property: key/,
    ],
  ])
    assert.throws(() => observationSteps([step]), message)
})

// A screen state: only the fields the classifier reads.
const ui = (fingerprint, flags = {}) => ({
  fingerprint,
  error: false,
  retry: false,
  ...flags,
})
const run = (
  kind,
  { requests = 1, before = ui('form'), states = [], ...rest } = {},
) => ({
  kind,
  fault: kind === 'success' ? 'null-result' : 'rejection',
  requests,
  realRequests: 0,
  before,
  timeline: states.map((state, i) => ({ elapsedMs: (i + 1) * 100, ui: state })),
  final: states.at(-1) ?? before,
  announced: [],
  uncaughtErrors: 0,
  devErrorOverlay: false,
  setup: [],
  ...rest,
})
const classes = (runs) =>
  Object.fromEntries(
    classifyActionRuns(runs).map((f) => [f.id, f.classification]),
  )

test('classifies what the user saw after a failed or repeated request', () => {
  const success = run('success', { states: [ui('sent')] })
  assert.deepEqual(
    classes([success, run('failure'), run('double-click', { requests: 2 })]),
    {
      'failure-feedback': 'SILENT_FAILURE',
      'double-click': 'DUPLICATE_SUBMIT',
    },
  )
  assert.deepEqual(
    classes([
      success,
      run('failure', { states: [ui('sent')] }),
      run('double-click'),
    ]),
    { 'failure-feedback': 'FALSE_SUCCESS', 'double-click': 'SINGLE_SUBMIT' },
  )
  assert.deepEqual(
    classes([
      success,
      run('failure', {
        states: [ui('busy'), ui('form+toast', { error: true }), ui('form')],
      }),
    ]),
    { 'failure-feedback': 'FEEDBACK_SHOWN' },
  )
  // A spinner that disappears again is not feedback.
  assert.equal(
    classes([success, run('failure', { states: [ui('busy'), ui('form')] })])[
      'failure-feedback'
    ],
    'SILENT_FAILURE',
  )
  assert.equal(
    classes([success, run('failure', { states: [ui('closed')] })])[
      'failure-feedback'
    ],
    'UNCLEAR_FEEDBACK',
  )
  // An error already on screen before the action doesn't count as feedback.
  assert.equal(
    classes([
      success,
      run('failure', {
        before: ui('form', { error: true }),
        states: [ui('form+x', { error: true })],
      }),
    ])['failure-feedback'],
    'UNCLEAR_FEEDBACK',
  )
})

test('a toast counts as feedback unless it is the one a success shows', () => {
  const toast = (announced, states = [ui('busy'), ui('form')]) =>
    run('failure', { states, announced })
  // A toast that has gone by the end of the observation still counts.
  assert.equal(
    classes([run('success', { states: [ui('sent')] }), toast(['e1'])])[
      'failure-feedback'
    ],
    'FEEDBACK_SHOWN',
  )
  assert.equal(
    classes([
      run('success', { states: [ui('form')], announced: ['saved'] }),
      toast(['saved']),
    ])['failure-feedback'],
    'FALSE_SUCCESS',
  )
  assert.equal(
    classes([
      run('success', { states: [ui('sent')], announced: ['saved'] }),
      toast(['saved', 'e1']),
    ])['failure-feedback'],
    'FEEDBACK_SHOWN',
  )
})

test('reports missing requests, uncaught errors and requests that reached the app', () => {
  assert.deepEqual(
    classes([
      run('success', { requests: 0 }),
      run('failure', { requests: 0 }),
      run('double-click', { requests: 0 }),
    ]),
    {
      success: 'NO_REQUEST',
      'failure-feedback': 'NO_REQUEST',
      'double-click': 'NO_REQUEST',
    },
  )
  const findings = classifyActionRuns([
    run('success', { states: [ui('sent')] }),
    run('failure', { uncaughtErrors: 1 }),
    run('double-click', { devErrorOverlay: true, realRequests: 1 }),
  ])
  const uncaught = findings.find((f) => f.id === 'uncaught-error')
  assert.equal(uncaught.classification, 'UNCAUGHT_ERROR')
  assert.match(uncaught.advice, /failure, double-click run/)
  assert.equal(
    findings.find((f) => f.id === 'real-requests').classification,
    'REAL_REQUEST_SENT',
  )
})
