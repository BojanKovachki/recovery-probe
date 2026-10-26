import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { observationSteps } from '../../dist/workflows/observe/steps.mjs'
import { runSteps } from '../../dist/workflows/observe/step-runner.mjs'
import {
  startNetworkFaultProxy,
  connectNetworkFaults,
} from '../../dist/net-fault.mjs'
import {
  networkSteps,
  applyNetworkEvidence,
} from '../../dist/workflows/observe/network.mjs'
import { networkStepSummary } from '../../dist/workflows/observe/summaries.mjs'

const refuse = { host: 'api.example.test', fault: 'refuse' }

/** Resolves with the proxy's answer to one CONNECT. */
const connectThrough = (proxy, host) =>
  new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:443`,
    })
    req.on('connect', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode)
    })
    req.on('error', () => resolve('error'))
    req.end()
  })

const runOptions = (network) => ({
  mark: async () => null,
  signal: new AbortController().signal,
  elapsed: () => 0,
  network,
})

test('network steps need a network control', () => {
  assert.throws(
    () => observationSteps([{ network: refuse }]),
    /needs a network control/,
  )
  assert.deepEqual(
    observationSteps(
      [{ network: refuse }, { network: [refuse] }, { network: 'restore' }],
      { network: true },
    ),
    [
      { kind: 'network', rules: [refuse] },
      { kind: 'network', rules: [refuse] },
      { kind: 'network', rules: null },
    ],
  )
  assert.throws(
    () =>
      observationSteps([{ network: { host: 'a.test', fault: 'drop' } }], {
        network: true,
      }),
    /steps\[0\]\.network: rules\[0\]\.fault/,
  )
})

test('runs network steps in order through the control', async () => {
  const calls = []
  const steps = observationSteps(
    [{ network: refuse }, { wait: 0 }, { network: 'restore' }],
    { network: true },
  )
  const results = await runSteps(
    {},
    steps,
    runOptions({
      arm: async (rules, step) => calls.push(['arm', step, rules.length]),
      restore: async (step) => calls.push(['restore', step]),
    }),
  )
  assert.deepEqual(calls, [
    ['arm', 0, 1],
    ['restore', 2],
  ])
  assert.ok(results.every((result) => result.status === 'done'))
  await assert.rejects(
    runSteps({}, steps, runOptions(undefined)),
    /NETWORK_CONTROL_MISSING/,
  )
})

test('records what each armed set faulted and restores at the end', async () => {
  const proxy = await startNetworkFaultProxy({ control: true })
  try {
    const network = networkSteps(connectNetworkFaults(proxy.url))
    await network.arm([refuse], 0)
    assert.equal(await connectThrough(proxy, 'api.example.test'), 502)
    await network.restore(2)
    await network.arm([{ host: 'unused.example.test', fault: 'stall' }], 3)
    const evidence = await network.finish()

    assert.deepEqual(evidence.faults, [
      {
        step: 0,
        rules: [
          {
            host: 'api.example.test',
            fault: 'refuse',
            matching: 1,
            applied: 1,
          },
        ],
      },
      { step: 2, restored: true },
      {
        step: 3,
        rules: [
          {
            host: 'unused.example.test',
            fault: 'stall',
            matching: 0,
            applied: 0,
          },
        ],
      },
    ])
    assert.equal(
      networkStepSummary(evidence.faults[0]),
      'Step 0: refuse api.example.test faulted 1 of 1 matching connection(s)',
    )
    // Finishing disarms: the stalled host is answered (the lookup fails) instead of hanging.
    assert.equal(await connectThrough(proxy, 'unused.example.test'), 502)
    assert.equal(proxy.summary().rules[0].matching, 0)

    const report = {
      status: 'complete',
      captureComplete: true,
      coverage: { gaps: [] },
    }
    applyNetworkEvidence(report, evidence)
    assert.equal(report.mode, 'observation with network faults')
    assert.deepEqual(report.coverage.gaps, ['NETWORK_FAULT_NOT_TRIGGERED'])
    assert.equal(report.captureComplete, false)
  } finally {
    await proxy.close()
  }
})

test('reports faults it could not remove', async () => {
  const proxy = await startNetworkFaultProxy({ control: true })
  const network = networkSteps(connectNetworkFaults(proxy.url))
  await network.arm([refuse], 0)
  await proxy.close()
  const evidence = await network.finish()
  assert.match(evidence.restoreError, /fetch failed|ECONNREFUSED/)

  const report = { status: 'complete', coverage: { gaps: [] } }
  applyNetworkEvidence(report, evidence)
  assert.ok(report.coverage.gaps.includes('NETWORK_FAULTS_NOT_RESTORED'))
})

test('leaves a report without network steps unchanged', () => {
  const report = {
    status: 'complete',
    mode: 'fault-free observation',
    coverage: { gaps: [] },
  }
  applyNetworkEvidence(report, { faults: [] })
  assert.equal(report.mode, 'fault-free observation')
  assert.equal(report.network, undefined)
})
