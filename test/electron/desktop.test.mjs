import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startDemoServer } from '../../examples/demo-server.mjs'
import { checkDesktop, discoverDesktop } from '../../dist/desktop.mjs'
import { attachWindow, launchElectron } from '../helpers/electron.mjs'
import { assertReportShape } from '../helpers/report-shape.mjs'
const exec = promisify(execFile)
let app
let browser
let page
let server
let cdp
let electron
before(
  async () => {
    server = await startDemoServer()
    electron = await launchElectron(
      fileURLToPath(new URL('../fixtures/electron/main.cjs', import.meta.url)),
      { env: { RECOVERY_PROBE_FIXTURE_URL: `${server.url}/fixed` } },
    )
    app = electron.app
    cdp = electron.cdp
    ;({ browser, page } = await attachWindow(cdp, `${server.url}/fixed`))
    const originalLocator = page.locator.bind(page)
    page.locator = (...args) => {
      const locator = originalLocator(...args)
      const originalClick = locator.click.bind(locator)
      locator.click = async (options) => {
        try {
          return await originalClick(options)
        } catch (error) {
          console.log('FIXTURE_CLICK_ERROR', error.message)
          throw error
        }
      }
      return locator
    }
    await page.locator('#profile').waitFor()
  },
  { timeout: 30000 },
)
after(async () => {
  if (browser) await browser.close()
  await electron?.stop()
  if (server) await server.close()
})
// Use the product's five-second default for real, non-forced UI actions in CI.
const config = (variant, extra = {}) => ({
  cdp,
  pageUrl: `${server.url}/${variant}`,
  endpoint: `${server.url}/api/profile`,
  readySelector: '#profile',
  readyText: 'Synthetic Example',
  retrySelector: '#retry',
  timeoutMs: 5000,
  ...extra,
})

test('connects to real Electron, preserves preload, discovers JSON requests without injecting', async () => {
  assert.equal(
    await page.evaluate(() => window.recoveryProbeFixture.kind),
    'electron-preload',
  )
  const discovery = await discoverDesktop(page, { durationMs: 200 })
  assert.deepEqual(
    discovery.endpoints.map((e) => e.endpoint),
    [`${server.url}/api/profile`],
  )
  assert.equal(await page.locator('#profile').innerText(), 'Synthetic Example')
})
test('catches the stuck retry in Electron for all three faults, and reload rescues it', async () => {
  await page.goto(`${server.url}/broken`)
  const report = await checkDesktop(page, config('broken'), {
    onFailure: async (target, row) => {
      console.log(
        'BROKEN_DIAGNOSTIC',
        JSON.stringify({
          row,
          status: await target.locator('#status').innerText(),
          retryVisible: await target.locator('#retry').isVisible(),
        }),
      )
    },
  })
  assert.equal(report.ok, false)
  assert.deepEqual(
    report.results.map((r) => r.outcome),
    ['fail', 'fail', 'fail'],
    JSON.stringify(report),
  )
  assert.ok(
    report.results.every(
      (r) =>
        r.applied === 1 &&
        r.retryClicked &&
        r.successfulResponsesAfterFault === 0 &&
        r.screenText === 'error\nRetry',
    ),
  )
  assert.equal(report.finalReset, 'healthy')
})
test('corrected Electron app recovers from all faults with subsequent real requests', async () => {
  await page.goto(`${server.url}/fixed`)
  const report = await checkDesktop(page, config('fixed'))
  await assertReportShape(report, 'check-desktop-http')
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.ok(
    report.results.every(
      (r) =>
        r.applied === 1 &&
        r.successfulResponsesAfterFault > 0 &&
        r.retryClicked,
    ),
  )
  assert.equal(
    await page.evaluate(() => window.recoveryProbeFixture.kind),
    'electron-preload',
  )
})
test('wrong endpoint and wrong health marker are inconclusive, never app failures', async () => {
  for (const { extra, reason } of [
    {
      extra: { endpoint: `${server.url}/absent` },
      reason: 'no successful response from the endpoint within 200 ms',
    },
    {
      extra: { readySelector: '#absent' },
      reason: 'the ready selector matched 0 elements',
    },
  ]) {
    const report = await checkDesktop(
      page,
      config('fixed', { ...extra, timeoutMs: 200 }),
    )
    assert.equal(report.results[0].code, 'BASELINE_FAILED')
    assert.equal(report.results[0].reason, reason)
    assert.ok(
      report.results.every((r) => r.applied === 0 && r.outcome !== 'fail'),
    )
  }
})
test('unavailable retry action is inconclusive and routing is cleaned up', async () => {
  const report = await checkDesktop(
    page,
    config('fixed', {
      faults: ['http-error'],
      retrySelector: '#absent',
      timeoutMs: 200,
    }),
  )
  assert.equal(report.results[0].code, 'RETRY_ACTION_UNAVAILABLE')
  assert.equal(report.results[0].outcome, 'inconclusive')
  assert.equal(report.finalReset, 'healthy')
  assert.equal(
    await page.evaluate(() => fetch('/api/profile').then((r) => r.status)),
    200,
  )
})
test('automatic recovery works without any retry selector', async () => {
  await page.goto(`${server.url}/automatic`)
  const report = await checkDesktop(
    page,
    config('automatic', { recovery: 'automatic', retrySelector: undefined }),
  )
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.ok(
    report.results.every(
      (r) => !r.retryClicked && r.successfulResponsesAfterFault > 0,
    ),
  )
})
test('a stale visible marker cannot pass without a successful request after the fault', async () => {
  await page.goto(`${server.url}/stale`)
  const report = await checkDesktop(
    page,
    config('stale', { recovery: 'automatic', faults: ['invalid-json'] }),
  )
  assert.equal(report.results[0].applied, 1)
  assert.equal(report.results[0].outcome, 'fail')
  assert.equal(report.results[0].successfulResponsesAfterFault, 0)
})
test('CLI writes useful reports and disconnecting leaves the Electron app alive', async () => {
  await page.goto(`${server.url}/fixed`)
  const dir = await mkdtemp(join(tmpdir(), 'recovery-desktop-cli-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const configPath = join(dir, 'input.json')
    await writeFile(
      configPath,
      JSON.stringify(config('fixed', { faults: ['http-error'] })),
    )
    const result = await exec(
      process.execPath,
      [
        fileURLToPath(new URL('../../bin/recovery-probe.mjs', import.meta.url)),
        'desktop',
        '--config',
        configPath,
        '--out',
        dir,
      ],
      { timeout: 20000 },
    )
    assert.match(result.stdout, /PASS/)
    assert.equal(
      JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).ok,
      true,
    )
    assert.match(
      await readFile(join(dir, 'fix-brief.md'), 'utf8'),
      /not an automatic diagnosis/,
    )
    assert.match(
      await readFile(join(dir, 'reproduce.mjs'), 'utf8'),
      /checkDesktop/,
    )
    assert.equal(app.exitCode, null)
    assert.equal(browser.contexts().flatMap((c) => c.pages()).length, 1)
    assert.equal(
      await page.evaluate(() => window.recoveryProbeFixture.kind),
      'electron-preload',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test(
  'guided Electron setup picks content and reuses saved setup without a window index',
  { timeout: 20000 },
  async () => {
    const { runStart } = await import('../../dist/tools/start/run.mjs')
    const { pickMarker } = await import('../../dist/tools/pick-marker.mjs')
    await page.goto(`${server.url}/fixed`)
    const dir = await mkdtemp(join(tmpdir(), 'guided-electron-'))
    const answers = ['', '1', '2', '', '5'] // ready, confirm marker, retry, default Retry label, deadline
    const io = { interactive: true, log() {}, ask: async () => answers.shift() }
    try {
      const result = await runStart({ target: 'desktop', cdp, dir }, io, {
        durationMs: 200,
        pick: async (target) => {
          const pending = pickMarker(target)
          await target.locator('[data-recovery-probe-picker]').waitFor()
          await target.locator('#profile').click()
          return pending
        },
      })
      assert.equal(result.report.ok, true, JSON.stringify(result.report))
      assert.equal(result.config.page, undefined)
      assert.equal(answers.length, 0)
      const rerun = await exec(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../bin/recovery-probe.mjs', import.meta.url),
          ),
          'start',
          'desktop',
          '--dir',
          dir,
        ],
        { timeout: 10000 },
      )
      assert.match(rerun.stdout, /PASS: invalid-json/)
      assert.equal(app.exitCode, null)
      assert.equal(
        await page.evaluate(() => window.recoveryProbeFixture.kind),
        'electron-preload',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
