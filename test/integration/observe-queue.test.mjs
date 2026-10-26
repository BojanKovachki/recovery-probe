import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { observationConfig } from '../../dist/workflows/observe/config.mjs'
import { runObservation } from '../../dist/workflows/observe/capture.mjs'
import { httpObservationAdapter } from '../../dist/workflows/observe/adapters.mjs'
import { observationSteps } from '../../dist/workflows/observe/steps.mjs'
import { runSteps } from '../../dist/workflows/observe/step-runner.mjs'
import { actionSummary } from '../../dist/workflows/observe/summaries.mjs'
import { installObserverKit } from '../../dist/workflows/observe/kit.mjs'

let browser,
  server,
  origin,
  jobs = []
before(async () => {
  const html = await readFile(
    new URL('../fixtures/queue.html', import.meta.url),
  )
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const json = (value) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/api/queue' && request.method === 'GET')
      setTimeout(
        () =>
          json(
            jobs.map((j) => ({
              ...j,
              progress: j.running
                ? Math.min(99, Math.floor((Date.now() - j.since) / 100))
                : 0,
            })),
          ),
        30,
      )
    else if (
      url.pathname.startsWith('/api/queue/') &&
      request.method === 'POST'
    ) {
      const id = url.pathname.split('/').pop()
      if (!jobs.some((j) => j.id === id))
        jobs.push({
          id,
          running: !jobs.some((j) => j.running),
          since: Date.now(),
        })
      json({ ok: true })
    } else {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(html)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })
})
after(async () => {
  await browser?.close()
  if (server)
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
})

const config = () =>
  observationConfig({
    transport: 'http',
    endpoint: origin + '/api/queue',
    regionSelector: '#queue-region',
    contentSelector: { css: 'button.job-action', text: 'Move up' },
    rows: {
      selector: 'li[data-job]',
      key: '.job-name',
      state: 'button.job-action',
      states: ['Pause', 'Move up'],
      aliases: { second: 'synthetic-private-job-b' },
    },
    actions: [
      { name: 'start', selector: { css: '[data-start]', role: 'button' } },
    ],
    lagThresholdMs: 1000,
    sampleMs: 50,
    observationMs: 6500,
  })
const steps = observationSteps([
  { click: '[data-start="job-a"]', name: 'start-first' },
  { wait: 700 },
  { mark: true },
  { click: { css: '#catalog button', text: 'Start B' }, name: 'start-second' },
  { wait: 4500 },
])

async function capture(fixed) {
  jobs = []
  const page = await browser.newPage()
  try {
    await page.goto(origin + (fixed ? '/?fixed=true' : '/'))
    const c = config()
    return await runObservation(page, c, httpObservationAdapter(page, c), {
      operator: ({ mark, signal, elapsed }) =>
        runSteps(page, steps, { mark, signal, elapsed }),
    })
  } finally {
    await page.close()
  }
}

test(
  'a state that outlives several completed reads after an action is reported as DELAYED_UI_UPDATE',
  { timeout: 30000 },
  async () => {
    const report = await capture(false)
    assert.equal(report.captureComplete, true, JSON.stringify(report.coverage))
    assert.equal(report.operator.status, 'complete')
    assert.deepEqual(
      report.operator.steps.map((s) => s.status),
      ['done', 'done', 'done', 'done', 'done'],
    )
    assert.equal(report.intervals.length, 2)
    const starts = report.actions.filter((a) => a.name === 'start')
    assert.equal(starts.length, 2)
    assert.ok(
      starts.every((a) => a.trusted),
      'scripted steps use real input events',
    )
    const finding = report.findings.find((f) => f.code === 'DELAYED_UI_UPDATE')
    assert.ok(finding, JSON.stringify(report.rows))
    assert.equal(finding.row, 'second')
    assert.equal(finding.from, 'Pause')
    assert.equal(finding.to, 'Move up')
    assert.equal(finding.basis, 'UNCHANGED_ACROSS_READS')
    assert.equal(finding.confidence, 'low')
    assert.ok(finding.unchangedReadCompletions >= 2)
    assert.ok(finding.persistedMs >= 1000)
    assert.equal(finding.afterAction.name, 'start')
    assert.ok(
      finding.afterAction.changedAfterActionMs[1] >= 2500 &&
        finding.afterAction.changedAfterActionMs[0] <= 3600,
      JSON.stringify(finding),
    )
    const effect = report.actionEffects.at(-1)
    assert.equal(effect.appeared[0].row, 'second')
    assert.equal(effect.appeared[0].state, 'Pause')
    assert.deepEqual(
      effect.appeared[0].changes.map((c) => [c.from, c.to]),
      [['Pause', 'Move up']],
    )
    assert.match(
      actionSummary(effect),
      /row ‘second’ appeared .* as Pause, then Pause → Move up/,
    )
    assert.ok(
      report.intervals[1].firstContent,
      'the Move up marker is found by text',
    )
    const json = JSON.stringify(report)
    assert.ok(
      !json.includes('synthetic-private-job'),
      'row key text is never stored',
    )
    assert.ok(
      report.rows.some((r) => r.row.startsWith('key:')),
      'unaliased rows are hashed',
    )
  },
)

test(
  'a queued row that shows its real state at once is not reported',
  { timeout: 30000 },
  async () => {
    const report = await capture(true)
    assert.equal(report.captureComplete, true, JSON.stringify(report.coverage))
    assert.equal(
      report.findings.filter((f) => f.code === 'DELAYED_UI_UPDATE').length,
      0,
      JSON.stringify(report.findings),
    )
    const second = report.rows.find((r) => r.row === 'second')
    assert.equal(second.firstSeen.state, 'Move up')
    assert.deepEqual(second.transitions, [])
  },
)

test(
  'steps reject cross-document navigation and ambiguous click targets',
  { timeout: 30000 },
  async () => {
    assert.throws(
      () => observationSteps([{ navigate: 'https://example.test/' }]),
      /same-document/,
    )
    assert.throws(
      () => observationSteps([{ click: 'button', wait: 10 }]),
      /exactly one/,
    )
    jobs = []
    const page = await browser.newPage()
    try {
      await page.goto(origin)
      const c = { ...config(), observationMs: 1500 }
      const report = await runObservation(
        page,
        c,
        httpObservationAdapter(page, c),
        {
          operator: ({ mark, signal, elapsed }) =>
            runSteps(page, observationSteps([{ click: '[data-start]' }]), {
              mark,
              signal,
              elapsed,
            }),
        },
      )
      assert.equal(report.operator.status, 'failed')
      assert.match(report.operator.error, /STEP_TARGET_NOT_UNIQUE/)
      assert.ok(report.coverage.gaps.includes('OPERATOR_STEPS_INCOMPLETE'))
      assert.equal(report.captureComplete, false)
      assert.equal(jobs.length, 0, 'an ambiguous step never clicks')
    } finally {
      await page.close()
    }
  },
)

test(
  'a click on a label is recorded once, although the browser also clicks its control',
  { timeout: 30000 },
  async () => {
    const page = await browser.newPage()
    try {
      await page.setContent(
        '<label class="switch"><input type="checkbox"><span>Show installed</span></label>',
      )
      await page.evaluate(installObserverKit, {
        token: 'labels',
        actions: [
          { name: 'toggle', selector: 'label.switch' },
          { name: 'box', selector: 'input' },
        ],
        validate: [],
      })
      const recorded = () =>
        page.evaluate(() =>
          globalThis.__recoveryProbeObserve
            .drainActions()
            .map((action) => action.name)
            .sort(),
        )
      await page.click('text=Show installed')
      assert.deepEqual(await recorded(), ['box', 'toggle'])
      await page.click('input')
      assert.deepEqual(await recorded(), ['box', 'toggle'])
      assert.equal(await page.isChecked('input'), false)
    } finally {
      await page.close()
    }
  },
)

test(
  'an expect step that sees nothing in time is unmet, and the script goes on',
  { timeout: 20000 },
  async () => {
    const page = await browser.newPage()
    try {
      await page.goto(origin + '/')
      const results = await runSteps(
        page,
        observationSteps([
          { expect: { css: '#catalog button', text: 'Start A' } },
          { expect: '#never-shown', timeoutMs: 300, name: 'missing' },
          { wait: 0 },
        ]),
        {
          mark: async () => null,
          signal: new AbortController().signal,
          elapsed: () => 0,
        },
      )
      assert.deepEqual(
        results.map((r) => r.status),
        ['done', 'unmet', 'done'],
      )
      assert.equal(
        results[1].error,
        'EXPECTATION_NOT_MET: no visible match within 300 ms',
      )
    } finally {
      await page.close()
    }
  },
)
