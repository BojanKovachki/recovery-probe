import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import { packageUrl, version } from '../core/package.mjs'
import { rowNotes } from '../reports/check.mjs'
import { reportFolder } from '../reports/folder.mjs'
import {
  probeRecovery,
  type ProbeRow,
  type RecoveryConfig,
} from '../workflows/check/browser.mjs'
import type { Values } from './args.mjs'
import { withEvidence } from '../reports/evidence.mjs'

interface DemoServer {
  url: string
  close(): Promise<void>
}

// The examples stay plain JavaScript, so the demo server is loaded by URL when needed.
const startDemoServer = async (): Promise<DemoServer> =>
  (
    (await import(packageUrl('examples/demo-server.mjs').href)) as {
      startDemoServer: () => Promise<DemoServer>
    }
  ).startDemoServer()

export interface RunnerReport {
  tool: string
  version: string
  generatedAt: string
  environment: { node: string; platform: string; chromium: string }
  mode: string
  apps: { name: string; ok: boolean; results: ProbeRow[] }[]
  expectedDemonstrationVerified?: boolean
}

const marker = (outcome: string) =>
  outcome === 'pass'
    ? 'PASS'
    : outcome === 'fail'
      ? 'CAUGHT'
      : outcome.toUpperCase()

function printSummary(report: RunnerReport) {
  console.log(`Recovery Probe ${report.version} — ${report.mode}\n`)
  for (const app of report.apps) {
    console.log(app.name)
    for (const row of app.results) {
      const injected = row.applied ? `, injected ${row.applied}` : ''
      console.log(
        `  ${marker(row.outcome).padEnd(12)} ${row.scenario} (${row.code}${injected})`,
      )
      for (const note of rowNotes(row)) console.log(`${' '.repeat(15)}${note}`)
    }
    console.log('')
  }
  if (report.mode === 'controlled demonstration')
    console.log(
      report.expectedDemonstrationVerified
        ? 'Demo verified: the happy path passes, the broken recovery is caught, and the fixed app recovers.'
        : 'Demo failed: the expected broken-versus-fixed distinction was not observed.',
    )
  else
    console.log(
      report.apps.every((app) => app.ok)
        ? 'Recovery check passed.'
        : 'Recovery check did not pass.',
    )
}

/**
 * Runs the built-in demo, or one JSON-runner config, in a headless Chromium,
 * then prints and saves the report.
 */
export async function runBrowserCheck(
  config: RecoveryConfig | 'demo',
  values: Values,
): Promise<void> {
  const report = await runApps(config)
  if (values.json) console.log(JSON.stringify(report, null, 2))
  else printSummary(report)
  await saveReport(report, config === 'demo', values)
}

/** The broken and the fixed demo app, each checked once. */
async function demoApps(browser: Browser, server: DemoServer) {
  const apps = []
  for (const variant of ['broken', 'fixed'])
    apps.push(
      await probeRecovery(browser, {
        name: `${variant} synthetic fixture`,
        url: `${server.url}/${variant}`,
        requestPattern: '**/api/profile',
        readySelector: '#profile',
        retrySelector: '#retry',
        timeoutMs: 1200,
      }),
    )
  return apps
}

// The demo passes when the broken app fails every fault once and the fixed app passes.
const demonstrated = (apps: RunnerReport['apps']) =>
  apps[0].results[0].outcome === 'pass' &&
  apps[0].results
    .slice(1)
    .every((row) => row.outcome === 'fail' && row.applied === 1) &&
  apps[1].ok

async function runApps(config: RecoveryConfig | 'demo') {
  const demo = config === 'demo'
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  let server: DemoServer | undefined
  try {
    if (demo) server = await startDemoServer()
    const apps = demo
      ? await demoApps(browser, server!)
      : [await probeRecovery(browser, config)]
    const report: RunnerReport = {
      tool: 'Recovery Probe',
      version,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        chromium: browser.version(),
      },
      mode: demo ? 'controlled demonstration' : 'configured recovery check',
      apps,
    }
    if (demo) {
      report.expectedDemonstrationVerified = demonstrated(apps)
      process.exitCode = report.expectedDemonstrationVerified ? 0 : 1
    } else process.exitCode = apps.every((app) => app.ok) ? 0 : 1
    return report
  } finally {
    await browser.close()
    if (server) await server.close()
  }
}

async function saveReport(report: RunnerReport, demo: boolean, values: Values) {
  const json =
    JSON.stringify(
      withEvidence(report, { workflow: 'check', transport: 'browser' }),
      null,
      2,
    ) + '\n'
  const directory = await reportFolder(
    demo ? 'demo' : 'check',
    values.out as string | undefined,
  )
  await writeFile(join(directory, 'report.json'), json, { mode: 0o600 })
  if (!values.json) console.log(`Report: ${join(directory, 'report.json')}`)
}
