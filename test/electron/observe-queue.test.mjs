import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachWindow, launchElectron } from '../helpers/electron.mjs'
import { connectIpcInspector } from '../../dist/ipc-inspector.mjs'
import { assertReportShape } from '../helpers/report-shape.mjs'

async function launch(fixed, cacheDir) {
  const electron = await launchElectron(
    fileURLToPath(
      new URL('../fixtures/queue-electron/main.cjs', import.meta.url),
    ),
    {
      inspect: true,
      env: { FIXTURE_FIXED: String(fixed), FIXTURE_CACHE_DIR: cacheDir },
    },
  )
  return { ...electron, ...(await attachWindow(electron.cdp, '/queue.html')) }
}

test(
  'real Electron observation with method selection, push data events and scripted steps flags only the delayed queue state',
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'observe-queue-electron-'))
    try {
      for (const fixed of [false, true]) {
        const cacheDir = join(dir, `cache-${fixed}`)
        await mkdir(cacheDir)
        await writeFile(join(cacheDir, 'job-a.cache'), 'a'.repeat(100))
        await writeFile(join(cacheDir, 'job-b.cache'), 'b'.repeat(200))
        const { app, browser, page, cdp, inspector, stop } = await launch(
          fixed,
          cacheDir,
        )
        let cli, control
        try {
          await page.locator('[data-start="job-b"]').waitFor()
          const config = {
            transport: 'ipc',
            cdp,
            inspector,
            channel: 'fixture:invoke',
            methods: ['read'],
            dataEvents: { channel: 'fixture:emit', methods: ['queueChanged'] },
            regionSelector: '#queue-region',
            contentSelector: {
              css: 'button.job-action',
              role: 'button',
              name: 'Move up',
            },
            rows: {
              selector: 'li[data-job]',
              key: '.job-name',
              state: { css: 'button.job-action', role: 'button' },
              states: ['Pause', 'Move up'],
              aliases: { second: 'synthetic-private-job-b' },
            },
            actions: [
              {
                name: 'start',
                selector: { css: '[data-start]', role: 'button' },
              },
            ],
            lagThresholdMs: 1000,
            sampleMs: 50,
            observationMs: 7000,
          }
          const steps = [
            { click: { role: 'button', name: 'Start A' } },
            { wait: 700 },
            { mark: true },
            {
              click: { role: 'button', name: 'Start B' },
              name: 'start-second',
            },
            { wait: 5000 },
          ]
          const configPath = join(dir, 'config.json'),
            stepsPath = join(dir, 'steps.json'),
            out = join(dir, fixed ? 'fixed' : 'broken')
          await writeFile(configPath, JSON.stringify(config))
          await writeFile(stepsPath, JSON.stringify(steps))
          cli = spawn(
            process.execPath,
            [
              fileURLToPath(
                new URL('../../bin/recovery-probe.mjs', import.meta.url),
              ),
              'observe',
              '--config',
              configPath,
              '--steps',
              stepsPath,
              '--out',
              out,
              '--files',
              cacheDir,
              '--json',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          )
          let output = '',
            errors = ''
          cli.stdout.on('data', (b) => {
            output += b
          })
          cli.stderr.on('data', (b) => {
            errors += b
          })
          const [code] = await once(cli, 'exit')
          cli = undefined
          assert.equal(code, 0, errors + output)
          const report = JSON.parse(
            await readFile(join(out, 'report.json'), 'utf8'),
          )
          assert.equal(
            report.captureComplete,
            true,
            JSON.stringify(report.coverage),
          )
          await assertReportShape(
            report,
            fixed ? 'observe-ipc-rows-fixed' : 'observe-ipc-rows-broken',
          )
          assert.equal(report.operator.status, 'complete')
          assert.match(errors, /Running 5 scripted steps; they act on the app/)
          assert.deepEqual(report.targetMethods, ['read'])
          assert.equal(report.metadata.ipcHook.capabilities.methods, true)
          assert.equal(report.metadata.ipcHook.capabilities.pushes, true)
          // The shared channel is busy; the selected method is not, so comparisons stay meaningful.
          const second = report.intervals[1]
          assert.ok(
            second.channelReads.calls > second.reads.calls * 3,
            JSON.stringify(second),
          )
          assert.ok(
            second.dataEvents >= 1,
            'the queue-changed push is a data event',
          )
          assert.equal(report.notes.length, 0, JSON.stringify(report.notes))
          assert.ok(
            report.actions
              .filter((a) => a.name === 'start')
              .every((a) => a.trusted),
          )
          const delayed = report.findings.filter(
            (f) => f.code === 'DELAYED_UI_UPDATE',
          )
          if (fixed) {
            assert.equal(delayed.length, 0, JSON.stringify(delayed))
            assert.equal(
              report.rows.find((r) => r.row === 'second').firstSeen.state,
              'Move up',
            )
          } else {
            assert.equal(delayed.length, 1, JSON.stringify(report.rows))
            assert.equal(delayed[0].row, 'second')
            assert.equal(delayed[0].basis, 'NO_DATA_EVENT_BEFORE_UI_CHANGE')
            assert.equal(delayed[0].confidence, 'medium')
            assert.ok(delayed[0].sinceLastDataEventMs >= 1000)
            assert.ok(delayed[0].unchangedReadCompletions >= 2)
            assert.equal(delayed[0].afterAction.name, 'start')
          }
          assert.ok(!JSON.stringify(report).includes('synthetic-private-job'))
          // Starting job B dropped its cache file during the second interval.
          assert.deepEqual(
            report.findings
              .filter((f) => f.code === 'LOCAL_FILES_REMOVED')
              .map(({ interval, summary }) => ({ interval, summary })),
            [
              {
                interval: 2,
                summary:
                  '1 file(s) removed and 0 shrunk on disk (0.0 MB no longer there).',
              },
            ],
          )
          assert.ok(!JSON.stringify(report).includes('job-b.cache'))
          assert.deepEqual(
            JSON.parse(await readFile(join(out, 'files.json'), 'utf8'))
              .intervals,
            [{ interval: 2, removed: ['job-b.cache'], shrunk: [] }],
          )
          control = await connectIpcInspector(inspector)
          const snapshot = await control.call('snapshot')
          assert.equal(snapshot.observingUntil, null)
          assert.equal(
            await page.evaluate(() =>
              Object.hasOwn(globalThis, '__recoveryProbeObserve'),
            ),
            false,
            'the in-page kit is removed',
          )
          assert.equal(app.exitCode, null)
        } finally {
          cli?.kill()
          control?.close()
          await browser.close()
          await stop()
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test(
  'file steps damage a file under --files, report what the app did with it and put it back',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'observe-file-faults-electron-'))
    try {
      const cacheDir = join(dir, 'cache')
      await mkdir(cacheDir)
      await writeFile(join(cacheDir, 'job-a.cache'), 'a'.repeat(100))
      const { browser, page, cdp, inspector, stop } = await launch(
        false,
        cacheDir,
      )
      let cli
      try {
        await page.locator('[data-start="job-b"]').waitFor()
        const configPath = join(dir, 'config.json'),
          stepsPath = join(dir, 'steps.json'),
          out = join(dir, 'report')
        await writeFile(
          configPath,
          JSON.stringify({
            transport: 'ipc',
            cdp,
            inspector,
            channel: 'fixture:invoke',
            methods: ['read'],
            regionSelector: '#catalog',
            contentSelector: '#catalog button',
            sampleMs: 100,
            observationMs: 4000,
          }),
        )
        // The fixture never repairs files, and never shows a message about them.
        await writeFile(
          stepsPath,
          JSON.stringify([
            { mark: true },
            { file: { path: 'job-a.cache', fault: 'remove' } },
            { expect: '#repairing', timeoutMs: 500, name: 'repairing' },
            { wait: 1000 },
          ]),
        )
        cli = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL('../../bin/recovery-probe.mjs', import.meta.url),
            ),
            'observe',
            '--config',
            configPath,
            '--steps',
            stepsPath,
            '--out',
            out,
            '--files',
            cacheDir,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let output = '',
          errors = ''
        cli.stdout.on('data', (b) => {
          output += b
        })
        cli.stderr.on('data', (b) => {
          errors += b
        })
        const [code] = await once(cli, 'exit')
        cli = undefined
        assert.equal(code, 0, errors + output)
        const report = JSON.parse(
          await readFile(join(out, 'report.json'), 'utf8'),
        )
        assert.equal(report.captureComplete, true, JSON.stringify(report))
        await assertReportShape(report, 'observe-ipc-file-faults')
        assert.equal(report.mode, 'observation with file faults')
        assert.deepEqual(report.fileFaults, [
          { step: 1, fault: 'remove', outcome: 'damaged', restored: true },
        ])
        // The static catalog is also content shown before a read.
        assert.deepEqual(
          report.findings
            .filter(({ code }) => code !== 'CONTENT_BEFORE_READ')
            .map(({ code, interval }) => [code, interval]),
          [
            ['LOCAL_FILE_NOT_REPAIRED', 2],
            ['EXPECTATION_NOT_MET', 2],
          ],
          'the removal by the step is not reported as LOCAL_FILES_REMOVED',
        )
        assert.match(
          output,
          /Interval 2: EXPECTATION_NOT_MET — Step 2 \(expect ‘repairing’\) saw no visible match in 0\.5 s\./,
        )
        assert.match(
          output,
          /Step 1: the file the step removed was still missing when the capture ended; Recovery Probe put it back/,
        )
        assert.equal(
          await readFile(join(cacheDir, 'job-a.cache'), 'utf8'),
          'a'.repeat(100),
        )
        assert.ok(!JSON.stringify(report).includes('job-a.cache'))
        assert.deepEqual(
          JSON.parse(await readFile(join(out, 'files.json'), 'utf8')).faults,
          [{ step: 1, path: 'job-a.cache' }],
        )
      } finally {
        cli?.kill()
        await browser.close()
        await stop()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
