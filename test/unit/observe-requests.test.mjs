import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observationSteps } from '../../dist/workflows/observe/steps.mjs'
import { runSteps } from '../../dist/workflows/observe/step-runner.mjs'
import {
  applyRequestEvidence,
  requestSteps,
} from '../../dist/workflows/observe/requests.mjs'
import { faultMode } from '../../dist/workflows/observe/report.mjs'
import { requestStepSummary } from '../../dist/workflows/observe/summaries.mjs'
import { fake } from '../helpers/fake.mjs'

/** @typedef {import('../../dist/workflows/observe/report.mjs').ObservationReport} ObservationReport */

test('request steps take one rule, a list of rules, or "restore"', () => {
  assert.deepEqual(
    observationSteps([
      { requests: { url: '**/image/*', fault: 'abort' } },
      { requests: [{ url: '**/api/*', fault: 'status', status: 503 }] },
      { requests: 'restore', name: 'back' },
    ]),
    [
      { kind: 'requests', rules: [{ url: '**/image/*', fault: 'abort' }] },
      {
        kind: 'requests',
        rules: [{ url: '**/api/*', fault: 'status', status: 503 }],
      },
      { kind: 'requests', rules: null, name: 'back' },
    ],
  )
  for (const [requests, message] of [
    [{ url: '', fault: 'abort' }, /url must be a URL glob/],
    [{ url: '*', fault: 'drop' }, /fault must be abort or status/],
    [{ url: '*', fault: 'status', status: 200 }, /status must be 400–599/],
    [{ url: '*', fault: 'abort', status: 503 }, /status needs fault "status"/],
    [{ url: '*', fault: 'abort', count: 1 }, /Unsupported .* property: count/],
    [[], /must list 1–10 rules/],
  ])
    assert.throws(() => observationSteps([{ requests }]), message)
})

/** A page whose routes the test answers the way the browser would send requests through them. */
function routedPage() {
  const routes = new Map()
  /** @type {import('playwright').Page} */
  const page = fake({
    route: async (url, handler) => {
      routes.set(url, handler)
    },
    unroute: async (url, handler) => {
      if (routes.get(url) === handler) routes.delete(url)
    },
  })
  /** Sends one request matching `url` through its route and says what the route did. */
  const send = async (url) => {
    const outcome = {}
    await routes.get(url)?.(
      fake({
        abort: async (code) => {
          outcome.aborted = code
        },
        fulfill: async ({ status }) => {
          outcome.status = status
        },
      }),
    )
    return outcome
  }
  return { page, routes, send }
}

test('request steps fail matching requests, count them and remove their routes', async () => {
  const { page, routes, send } = routedPage()
  const requests = requestSteps(page)
  await runSteps(
    page,
    observationSteps([
      {
        requests: [
          { url: '**/image/*', fault: 'abort' },
          { url: '**/api/*', fault: 'status', status: 503 },
        ],
      },
    ]),
    {
      mark: async () => null,
      signal: new AbortController().signal,
      elapsed: () => 0,
      requests,
    },
  )
  assert.deepEqual(await send('**/image/*'), { aborted: 'blockedbyclient' })
  assert.deepEqual(await send('**/image/*'), { aborted: 'blockedbyclient' })
  assert.deepEqual(await send('**/api/*'), { status: 503 })
  await requests.restore(1)
  assert.equal(routes.size, 0)
  const evidence = await requests.finish()
  assert.deepEqual(evidence.faults.map(requestStepSummary), [
    'Step 0: 2 request(s) to **/image/* aborted; Step 0: 1 request(s) to **/api/* answered with 503',
    'Step 1: page requests restored',
  ])
})

test('a later request step replaces the armed rules, and finishing removes them', async () => {
  const { page, routes } = routedPage()
  const requests = requestSteps(page)
  await requests.arm([{ url: 'a', fault: 'abort' }], 0)
  await requests.arm([{ url: 'b', fault: 'abort' }], 1)
  assert.deepEqual([...routes.keys()], ['b'])
  await requests.finish()
  assert.equal(routes.size, 0)
})

test('reports rules that failed no request, and rules it could not remove', async () => {
  const requests = requestSteps(
    fake({
      route: async () => {},
      unroute: async () => {
        throw new Error('Target page, context or browser has been closed')
      },
    }),
  )
  await requests.arm([{ url: '**/nothing/*', fault: 'abort' }], 0)
  const evidence = await requests.finish()
  assert.match(evidence.restoreError ?? '', /has been closed/)
  /** @type {ObservationReport} */
  const report = fake({
    status: 'complete',
    captureComplete: true,
    coverage: fake({ gaps: [] }),
  })
  applyRequestEvidence(report, evidence)
  assert.equal(report.mode, 'observation with request faults')
  assert.deepEqual(report.coverage?.gaps, [
    'REQUEST_FAULT_NOT_TRIGGERED',
    'REQUEST_FAULTS_NOT_RESTORED',
  ])
  assert.equal(report.captureComplete, false)
})

test('the mode names every kind of fault the steps used', () => {
  /** @param {Partial<ObservationReport>} faults */
  const mode = (faults) => faultMode(fake(faults))
  const network = { faults: [] }
  const requests = { faults: [] }
  const fileFaults = [fake({ step: 0 })]
  assert.equal(mode({ network }), 'observation with network faults')
  assert.equal(mode({ fileFaults }), 'observation with file faults')
  assert.equal(
    mode({ network, fileFaults }),
    'observation with network and file faults',
  )
  assert.equal(
    mode({ network, requests, fileFaults }),
    'observation with network, request and file faults',
  )
})
