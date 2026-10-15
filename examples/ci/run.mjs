// Runnable synthetic CI example. Adapt the fixture, actions and assertions to your app.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright'
import { withFault } from 'recovery-probe'
import { startDemoServer } from '../demo-server.mjs'

const variant = process.argv[2]
const output = process.argv[3]
if (
  !['broken', 'fixed'].includes(variant) ||
  !output ||
  process.argv.length !== 4
) {
  console.error(
    'Usage: node examples/ci/run.mjs broken|fixed NEW_OUTPUT_DIRECTORY',
  )
  process.exitCode = 2
} else {
  const directory = resolve(output)
  await mkdir(directory, { mode: 0o700 }) // Never overwrite a previous experiment.
  const scenario = JSON.parse(
    await readFile(new URL('./scenario.json', import.meta.url), 'utf8'),
  )
  const report = {
    variant,
    status: 'inconclusive',
    code: 'SETUP_FAILED',
    baseline: false,
    fault: null,
    cleanup: 'not-started',
  }
  let server, browser
  try {
    server = await startDemoServer()
    browser = await chromium.launch()
    async function inPage(name, exercise) {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      try {
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        })
        const page = await context.newPage()
        page.setDefaultTimeout(scenario.timeoutMs)
        page.setDefaultNavigationTimeout(scenario.timeoutMs)
        await exercise(page)
      } finally {
        try {
          await context.tracing.stop({
            path: join(directory, `${name}-trace.zip`),
          })
        } finally {
          await context.close()
        }
      }
    }
    const ready = async (page) => {
      await page.locator(scenario.readySelector).waitFor({ state: 'visible' })
      assert.equal(
        await page.locator(scenario.readySelector).textContent(),
        scenario.expectedText,
      )
    }
    await inPage('baseline', async (page) => {
      await page.goto(`${server.url}/${variant}`, {
        waitUntil: 'domcontentloaded',
      })
      await ready(page)
    })
    report.baseline = true
    await inPage('fault', async (page) => {
      report.fault = await withFault(
        page,
        {
          ...scenario.fault,
          match: `${server.url}${scenario.requestPath}`,
          method: 'GET',
        },
        async () => {
          await page.goto(`${server.url}/${variant}`, {
            waitUntil: 'domcontentloaded',
          })
          await page
            .locator(scenario.retrySelector)
            .waitFor({ state: 'visible' })
          await page.locator(scenario.retrySelector).click()
          await ready(page)
        },
      )
    })
    assert.equal(report.fault.applied, 1)
    report.status = 'pass'
    report.code = 'OK'
  } catch (error) {
    report.status =
      error.code === 'RECOVERY_ASSERTION_FAILED' ? 'fail' : 'inconclusive'
    report.code = error.code ?? 'RUNNER_ERROR'
    report.fault = error.stats ?? report.fault
  } finally {
    const cleanup = await Promise.allSettled([
      browser?.close(),
      server?.close(),
    ])
    report.cleanup = cleanup.every((r) => r.status === 'fulfilled')
      ? 'complete'
      : 'unverified'
    if (report.cleanup !== 'complete') {
      report.status = 'inconclusive'
      report.code = 'CLEANUP_FAILED'
    }
  }
  await writeFile(
    join(directory, 'scenario.json'),
    JSON.stringify(scenario, null, 2),
    { mode: 0o600 },
  )
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  )
  const summary = `| Variant | Baseline | Faults applied | Result | Code |\n| --- | --- | --- | --- | --- |\n| ${variant} | ${report.baseline ? 'passed' : 'not established'} | ${report.fault?.applied ?? 0} | ${report.status} | ${report.code} |\n`
  await writeFile(join(directory, 'summary.md'), summary, { mode: 0o600 })
  console.log(summary)
  process.exitCode =
    report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 2
}
