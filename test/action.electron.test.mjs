import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort } from './repair-fixture.mjs'
import { connectDesktop, desktopPages } from '../dist/desktop.mjs'
import { connectIpcInspector } from '../dist/ipc-inspector.mjs'
import { checkAction } from '../dist/ipc-action.mjs'
const require = createRequire(import.meta.url)
const exec = promisify(execFile)

const classes = (report) =>
  Object.fromEntries(report.findings.map((f) => [f.id, f.classification]))

test(
  'real IPC action check: silent failure, false success, honest feedback and double-click',
  { timeout: 180000 },
  async () => {
    const cdpPort = await freePort()
    let inspectorPort = await freePort()
    while (inspectorPort === cdpPort) inspectorPort = await freePort()
    const cdp = `http://127.0.0.1:${cdpPort}`
    const inspector = `http://127.0.0.1:${inspectorPort}`
    const app = spawn(
      require('electron'),
      [
        '--no-sandbox',
        `--inspect=127.0.0.1:${inspectorPort}`,
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${cdpPort}`,
        fileURLToPath(
          new URL('./fixtures/ipc-electron/main.cjs', import.meta.url),
        ),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let errors = ''
    app.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-10000)
    })
    let browser
    let control
    const dir = await mkdtemp(join(tmpdir(), 'ipc-action-'))
    try {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (app.exitCode !== null) throw new Error(errors)
        try {
          if (
            (await fetch(cdp + '/json/version')).ok &&
            (await fetch(inspector + '/json/list')).ok
          )
            break
        } catch {}
        await new Promise((r) => setTimeout(r, 100))
      }
      browser = await connectDesktop(cdp)
      let page
      while (Date.now() < deadline) {
        page = desktopPages(browser).find((p) =>
          p.url().includes('ipc-electron/index.html'),
        )
        if (page) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(page, errors)
      const baseUrl = page.url().split('?')[0]
      control = await connectIpcInspector(inspector)
      const config = {
        cdp,
        inspector,
        channel: 'fixture:write',
        setup: [{ fill: '#email', value: 'must-not-persist@example.invalid' }],
        action: '#send',
        latencyMs: 300,
        observationMs: 1500,
        sampleMs: 50,
      }
      const check = async (mode) => {
        await page.goto(`${baseUrl}?mode=${mode}`)
        await page.locator('#send').waitFor()
        const report = await checkAction(config)
        assert.equal(report.error, undefined, report.error)
        assert.equal(report.finalReset, 'healthy')
        assert.ok(report.runs.every((run) => run.realRequests === 0))
        assert.ok(!JSON.stringify(report).includes('must-not-persist'))
        return report
      }

      // Awaits the write, ignores its failure and has no guard.
      const silent = await check('form-silent')
      assert.deepEqual(classes(silent), {
        'failure-feedback': 'SILENT_FAILURE',
        'uncaught-error': 'UNCAUGHT_ERROR',
        'double-click': 'DUPLICATE_SUBMIT',
      })
      assert.equal(
        silent.runs.find((r) => r.kind === 'double-click').requests,
        2,
      )
      assert.equal(silent.ok, false)

      // Shows success without waiting for the write.
      const falseSuccess = await check('form-false-success')
      assert.equal(classes(falseSuccess)['failure-feedback'], 'FALSE_SUCCESS')
      assert.equal(classes(falseSuccess)['uncaught-error'], undefined)

      // Disables Send while writing and shows an error on failure.
      const honest = await check('form-honest')
      assert.deepEqual(classes(honest), {
        'failure-feedback': 'FEEDBACK_SHOWN',
        'double-click': 'SINGLE_SUBMIT',
      })
      assert.equal(honest.ok, true)

      // A short-lived status message without error words still counts as feedback.
      const toast = await check('form-toast')
      assert.equal(classes(toast)['failure-feedback'], 'FEEDBACK_SHOWN')
      const toastFailure = toast.runs.find((r) => r.kind === 'failure')
      assert.equal(toastFailure.announced.length, 1)
      assert.equal(
        toastFailure.final.fingerprint,
        toastFailure.before.fingerprint,
      )

      // The CLI writes the report, keeps the typed value out of it and exits 2 for leads.
      await page.goto(`${baseUrl}?mode=form-silent`)
      await page.locator('#send').waitFor()
      const configFile = join(dir, 'action.json')
      await writeFile(configFile, JSON.stringify(config))
      const out = join(dir, 'cli')
      const cli = await exec(
        process.execPath,
        [
          fileURLToPath(new URL('../bin/recovery-probe.mjs', import.meta.url)),
          'ipc',
          '--action',
          '--config',
          configFile,
          '--out',
          out,
        ],
        { timeout: 60000 },
      ).catch((error) => error)
      assert.equal(cli.code, 2, cli.stderr)
      assert.match(
        cli.stdout,
        /SUSPECTED-DEFECT: failure-feedback — SILENT_FAILURE/,
      )
      assert.match(
        cli.stdout,
        /SUSPECTED-DEFECT: double-click — DUPLICATE_SUBMIT/,
      )
      assert.ok(
        !(await readFile(join(out, 'report.json'), 'utf8')).includes(
          'must-not-persist',
        ),
      )
      assert.match(
        await readFile(join(out, 'report.html'), 'utf8'),
        /SILENT_FAILURE/,
      )
      assert.equal((await control.call('snapshot')).armed, null)
      assert.equal(app.exitCode, null)
    } finally {
      control?.close()
      if (browser) await browser.close()
      if (app.exitCode === null) {
        const exited = new Promise((resolve) => app.once('exit', resolve))
        app.kill()
        await exited
      }
      await rm(dir, { recursive: true, force: true })
    }
  },
)
