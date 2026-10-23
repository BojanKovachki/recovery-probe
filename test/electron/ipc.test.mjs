import { runRefresh } from '../../dist/refresh.mjs'
import { ipcRefreshAdapter } from '../../dist/refresh-adapters.mjs'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachWindow, launchElectron } from '../helpers/electron.mjs'
import { connectIpcInspector } from '../../dist/ipc-inspector.mjs'
import { prepareVisibility, windowVisibility } from '../../dist/visibility.mjs'
import { discoverIpc } from '../../dist/ipc-discover.mjs'
import { checkIpc } from '../../dist/ipc-check.mjs'
const exec = promisify(execFile)

test(
  'real IPC: registration hook, serialized rejection, real retry, null and dependency boundaries, CLI cleanup',
  { timeout: 240000 },
  async () => {
    const electron = await launchElectron(
      fileURLToPath(
        new URL('../fixtures/ipc-electron/main.cjs', import.meta.url),
      ),
      { inspect: true },
    )
    const { app, cdp, inspector } = electron
    let browser
    let control
    const dir = await mkdtemp(join(tmpdir(), 'ipc-check-'))
    try {
      let page
      ;({ browser, page } = await attachWindow(cdp, 'ipc-electron/index.html'))
      await page.locator('#row').waitFor()
      control = await connectIpcInspector(inspector)
      assert.equal(
        await page.evaluate(() => typeof window.__recoveryProbeIpc),
        'undefined',
      )
      for (let i = 0; i < 16; i++) {
        assert.ok(
          (await control.call('identify')).registered.includes('fixture:read'),
        )
        assert.equal(await control.call('snapshot'), null)
      }
      await assert.rejects(
        control.call('identify', randomUUID()),
        /does not match/,
      )
      const config = {
        cdp,
        inspector,
        channel: 'fixture:read',
        requiredChannels: ['fixture:versions'],
        readySelector: '#row',
        readyText: 'rp-fixture-cube.fbx',
        busySelector: '#spinner',
        retryDelayMs: 30,
        renderMarginMs: 500,
        baselineTimeoutMs: 5000,
      }
      const report = await checkIpc(config)
      assert.equal(report.ok, true, JSON.stringify(report))
      assert.equal(
        await page.evaluate(() =>
          Object.hasOwn(globalThis, '__recoveryProbeWindowNonce'),
        ),
        false,
      )
      assert.equal(report.baseline.snapshot.channels['fixture:read'].calls, 1)
      assert.equal(report.results[0].snapshot.injected, 1)
      assert.equal(report.results[0].snapshot.successfulAfterFault, 1)
      assert.equal((await control.call('snapshot')).armed, null)
      // Simulate a protocol failure AFTER the real main-process begin has armed a
      // fault. There must be no reload/injection before the checker disarms it.
      let lostReply = false
      let uncertainId
      let observedReset
      const unreliable = {
        async call(method, argument) {
          const result = await control.call(method, argument)
          if (method === 'begin' && argument.fault && !lostReply) {
            lostReply = true
            uncertainId = argument.id
            throw new Error('simulated lost begin reply')
          }
          if (method === 'reset' && argument === uncertainId)
            observedReset = result
          return result
        },
        close() {},
      }
      const uncertain = await checkIpc(config, {
        connectControl: async () => unreliable,
      })
      assert.equal(lostReply, true)
      assert.equal(uncertain.ok, false)
      assert.match(uncertain.error, /lost begin reply/)
      assert.equal(uncertain.results.length, 0)
      assert.equal(observedReset.armed, null)
      assert.equal(observedReset.injected, 0)
      assert.equal(uncertain.finalReset, 'healthy')
      assert.equal((await control.call('snapshot')).armed, null)
      const nullResult = await checkIpc({ ...config, faults: ['null-result'] })
      assert.equal(
        nullResult.results[0].code,
        'RECOVERY_NOT_OBSERVED',
        JSON.stringify(nullResult),
      )
      assert.equal(nullResult.results[0].outcome, 'fail')
      assert.equal(nullResult.finalReset, 'healthy')
      const baseUrl = page.url().split('?')[0]
      await page.goto(baseUrl + '?mode=broken')
      const broken = await checkIpc(config)
      assert.equal(broken.results[0].outcome, 'fail', JSON.stringify(broken))
      assert.equal(broken.results[0].snapshot.successfulAfterFault, 0)
      await page.goto(baseUrl + '?mode=dependency-failure')
      const dependent = await checkIpc(config)
      assert.equal(
        dependent.baseline.code,
        'DEPENDENCY_FAILED',
        JSON.stringify(dependent),
      )
      assert.equal(dependent.results.length, 0)
      assert.equal(dependent.baseline.snapshot.injected, 0)
      await page.goto(baseUrl)
      await page.locator('#row').waitFor()
      const discoveryConfig = {
        cdp,
        inspector,
        channel: 'fixture:read',
        requiredChannels: ['fixture:versions'],
        observationMs: 900,
        baselineTimeoutMs: 1500,
        repeats: 3,
        settleMs: 300,
      }
      const discovered = await discoverIpc(discoveryConfig)
      assert.equal(discovered.error, undefined, JSON.stringify(discovered))
      assert.equal(discovered.findings[0].classification, 'RECOVERED')
      assert.equal(discovered.findings[1].classification, 'SILENT_EMPTY')
      assert.equal(discovered.findings[2].classification, 'SILENT_EMPTY')
      assert.ok(discovered.findings.every((f) => f.repeatConfirmed))
      assert.equal(discovered.finalReset, 'healthy')
      assert.ok(discovered.results[0].recoveryMs >= 0)
      assert.ok(!JSON.stringify(discovered).includes('rp-fixture-cube.fbx'))
      await page.goto(baseUrl + '?mode=two-reads')
      const twoReads = await discoverIpc({ ...discoveryConfig, repeats: 1 })
      assert.equal(twoReads.error, undefined, JSON.stringify(twoReads))
      assert.deepEqual(twoReads.readiness.callsPerLoad, [2, 2, 2])
      assert.equal(twoReads.readiness.callsGap, undefined)
      assert.equal(twoReads.findings[0].classification, 'RECOVERED')
      assert.deepEqual(
        twoReads.findings.map((f) => f.id),
        ['rejection-1', 'rejection-2', 'null-result-1', 'rejection-1-call2'],
      )
      assert.equal(twoReads.findings[3].call, 2)
      assert.equal(twoReads.findings[3].classification, 'SILENT_EMPTY')
      assert.equal(
        twoReads.results[3].snapshot.channels['fixture:read'].realCalls,
        1,
      )
      assert.equal(twoReads.finalReset, 'healthy')
      await page.goto(baseUrl + '?mode=grid')
      const grid = await discoverIpc({ ...discoveryConfig, repeats: 1 })
      assert.equal(grid.error, undefined, JSON.stringify(grid))
      assert.equal(grid.findings[0].classification, 'CONTENT_LOSS')
      assert.equal(grid.findings[2].classification, 'CONTENT_LOSS')
      assert.equal(grid.results[0].observation.before.images, 13)
      assert.equal(grid.results[0].observation.after.images, 0)
      await page.goto(baseUrl + '?mode=delayed-control')
      await page.locator('#grid img').first().waitFor()
      await page.evaluate(() => sessionStorage.setItem('fixtureReloads', '0'))
      const delayedControl = await discoverIpc({
        ...discoveryConfig,
        baselineTimeoutMs: 3000,
        repeats: 1,
      })
      assert.equal(
        delayedControl.error,
        undefined,
        JSON.stringify(delayedControl),
      )
      assert.equal(delayedControl.results[0].control.ui.images, 13)
      assert.equal(
        delayedControl.results[0].control.ui.fingerprint,
        delayedControl.baselines[0].ui.fingerprint,
      )
      assert.equal(delayedControl.finalReset, 'healthy')
      for (const mode of [
        'delayed-baseline',
        'empty-region',
        'unstable-baseline',
      ]) {
        await page.goto(baseUrl + '?mode=' + mode)
        await page.locator('#spinner').waitFor({ state: 'hidden' })
        await page.evaluate(() => sessionStorage.setItem('fixtureReloads', '0'))
        const calibration = await discoverIpc({
          ...discoveryConfig,
          repeats: 1,
          ...(mode === 'empty-region' ? { regionSelector: '#grid' } : {}),
        })
        assert.equal(
          calibration.baselines.length,
          3,
          JSON.stringify(calibration),
        )
        assert.ok(
          calibration.baselines.every(
            (b) => b.elapsedMs >= discoveryConfig.baselineTimeoutMs,
          ),
        )
        if (mode === 'unstable-baseline') {
          assert.match(calibration.error, /BASELINE_UNSTABLE/)
          assert.equal(calibration.readiness.calibrationComplete, false)
          assert.equal(calibration.results.length, 0)
          assert.equal(calibration.finalReset, 'not-verified')
        } else {
          assert.equal(
            calibration.error,
            undefined,
            JSON.stringify(calibration),
          )
          assert.equal(calibration.readiness.calibrationComplete, true)
          assert.ok(
            calibration.baselines.every(
              (b) =>
                b.ready && b.ui.images === (mode === 'empty-region' ? 0 : 13),
            ),
          )
          assert.equal(calibration.results[0].snapshot.injected, 1)
          if (mode === 'delayed-baseline')
            assert.equal(calibration.findings[0].classification, 'CONTENT_LOSS')
          else
            assert.ok(
              calibration.findings.every((f) => f.kind !== 'suspected-defect'),
            )
          assert.equal(calibration.finalReset, 'healthy')
        }
        assert.equal((await control.call('snapshot')).armed, null)
      }
      await page.goto(baseUrl + '?mode=refresh')
      await page.locator('#row').waitFor()
      const refreshConfig = {
        transport: 'ipc',
        cdp,
        inspector,
        channel: 'fixture:read',
        requiredChannels: ['fixture:versions'],
        trigger: { type: 'dom-event', target: 'window', name: 'online' },
        fault: 'rejection',
        times: 1,
        repeats: 1,
        baselineTimeoutMs: 3000,
        observationMs: 500,
        idleMs: 200,
        settleMs: 100,
        secondTrigger: true,
      }
      const refreshAdapter = () =>
        ipcRefreshAdapter(
          control,
          refreshConfig,
          report.baseline.snapshot.senderId,
        )
      const refresh = await runRefresh(page, refreshConfig, refreshAdapter())
      assert.equal(refresh.error, undefined, JSON.stringify(refresh))
      assert.equal(refresh.results[0].code, 'CONTENT_LOSS_ON_REFRESH')
      assert.equal(
        refresh.results[0].secondTriggerResult,
        'RECOVERED_AFTER_TRIGGER',
      )
      assert.equal(refresh.finalReset, 'healthy')
      const refreshNull = await runRefresh(
        page,
        { ...refreshConfig, fault: 'null-result' },
        refreshAdapter(),
      )
      assert.equal(refreshNull.results[0].code, 'CONTENT_LOSS_ON_REFRESH')
      const refreshPartial = await runRefresh(
        page,
        { ...refreshConfig, times: 2 },
        refreshAdapter(),
      )
      assert.equal(refreshPartial.results[0].code, 'FAULT_NOT_TRIGGERED')
      assert.equal(refreshPartial.results[0].secondTrigger, undefined)
      assert.equal((await control.call('snapshot')).armed, null)
      await page.goto(baseUrl + '?mode=refresh-retry')
      await page.locator('#row').waitFor()
      const refreshRetry = await runRefresh(
        page,
        { ...refreshConfig, secondTrigger: false },
        refreshAdapter(),
      )
      assert.equal(refreshRetry.results[0].code, 'RECOVERED_AUTOMATICALLY')
      const refreshFile = join(dir, 'refresh.json')
      await writeFile(
        refreshFile,
        JSON.stringify({ ...refreshConfig, secondTrigger: false }),
      )
      const refreshCli = await exec(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../bin/recovery-probe.mjs', import.meta.url),
          ),
          'refresh',
          '--config',
          refreshFile,
          '--out',
          join(dir, 'refresh-cli'),
          '--json',
        ],
        { timeout: 20000 },
      )
      assert.equal(JSON.parse(refreshCli.stdout).ok, true)
      assert.equal((await control.call('snapshot')).armed, null)
      await control.call('setWindowMinimized', true)
      for (
        let i = 0;
        i < 20 && !(await control.call('windowState')).minimized;
        i++
      )
        await new Promise((r) => setTimeout(r, 50))
      assert.equal(
        (await windowVisibility(page, control)).windowState,
        'minimized',
      )
      const restoredWindow = await prepareVisibility(page, {
        restoreWindow: true,
        control,
      })
      assert.notEqual(
        (await windowVisibility(page, control)).windowState,
        'minimized',
      )
      await restoredWindow.revert()
      assert.equal((await control.call('windowState')).minimized, true)
      await control.call('setWindowMinimized', false)
      await page.goto(baseUrl + '?mode=honest')
      const honest = await discoverIpc(discoveryConfig)
      assert.equal(honest.error, undefined, JSON.stringify(honest))
      assert.equal(honest.findings[0].classification, 'RECOVERED')
      assert.ok(
        honest.findings
          .slice(1)
          .every((f) => f.classification === 'ERROR_OR_RETRY_SHOWN'),
      )
      assert.equal(honest.ok, true, JSON.stringify(honest))
      await page.goto(baseUrl)
      const configFile = join(dir, 'scenario.json')
      const out = join(dir, 'result')
      await writeFile(configFile, JSON.stringify(config))
      const result = await exec(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../bin/recovery-probe.mjs', import.meta.url),
          ),
          'ipc',
          '--config',
          configFile,
          '--out',
          out,
        ],
        { timeout: 15000 },
      )
      assert.match(result.stdout, /PASS: rejection/)
      assert.equal(
        JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).ok,
        true,
      )
      assert.equal((await control.call('snapshot')).armed, null)
      await page.goto(baseUrl + '?mode=honest')
      const discoverFile = join(dir, 'discover.json')
      await writeFile(
        discoverFile,
        JSON.stringify({
          ...discoveryConfig,
          repeats: 1,
          readyText: 'must-not-persist',
        }),
      )
      const discoveryOut = join(dir, 'discovery')
      const cliDiscovery = await exec(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../bin/recovery-probe.mjs', import.meta.url),
          ),
          'ipc',
          '--discover',
          '--screenshots',
          '--config',
          discoverFile,
          '--out',
          discoveryOut,
        ],
        { timeout: 30000 },
      )
      assert.match(cliDiscovery.stdout, /ERROR_OR_RETRY_SHOWN/)
      const shots = (await readdir(discoveryOut)).filter((name) =>
        name.endsWith('.png'),
      )
      assert.deepEqual(shots.sort(), [
        'baseline.png',
        'null-result-1-run1.png',
        'rejection-1-run1.png',
        'rejection-2-run1.png',
      ])
      assert.match(
        await readFile(join(discoveryOut, 'report.html'), 'utf8'),
        /<img alt="The screen at the end of the run" src="rejection-2-run1\.png">/,
      )
      assert.ok(
        !(await readFile(join(discoveryOut, 'scenario.json'), 'utf8')).includes(
          'must-not-persist',
        ),
      )
      // init finds the hook and reruns the channels saved by an earlier setup.
      const initDir = join(dir, 'init')
      await mkdir(initDir)
      await writeFile(
        join(initDir, 'discover.json'),
        JSON.stringify({ ...discoveryConfig, repeats: 1 }),
      )
      const init = await exec(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../bin/recovery-probe.mjs', import.meta.url),
          ),
          'init',
          '--cdp',
          cdp,
          '--inspector',
          inspector,
          '--dir',
          initDir,
        ],
        { timeout: 30000 },
      )
      assert.match(init.stdout, /Using the channels saved/)
      assert.match(init.stdout, /rejection-1 — RECOVERED/)
      assert.equal((await control.call('snapshot')).armed, null)
      assert.equal(app.exitCode, null)
    } finally {
      control?.close()
      if (browser) await browser.close()
      await electron.stop()
      await rm(dir, { recursive: true, force: true })
    }
  },
)
