import { readFile } from 'node:fs/promises'
import { connectDesktop, selectDesktopPage } from '../targets/cdp.mjs'
import { checkDesktop, type DesktopReport } from '../workflows/check/http.mjs'
import {
  discoverHttp,
  httpDiscoveryConfig,
  type HttpDiscoveryReport,
} from '../workflows/discover/http.mjs'
import { screenshotsIn } from '../workflows/discover/screenshots.mjs'
import { writeDiscoveryReport } from '../reports/discovery.mjs'
import { prepareVisibility } from '../targets/visibility.mjs'
import { writeDesktopReport } from '../reports/check.mjs'
import { reportFolder } from '../reports/folder.mjs'

export async function attachMain(args: string[]) {
  const options: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--discover', '--screenshots', '--restore-window'].includes(arg))
      options[arg.slice(2)] = true
    else if (
      ['--config', '--cdp', '--out', '--page'].includes(arg) &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      options[arg.slice(2)] = args[++i]
    else
      throw new Error(
        'Use web --attach [--discover [--screenshots]] --config FILE [--cdp URL] [--page N] [--restore-window] [--out NEW_DIRECTORY]',
      )
  }
  if (!options.config) throw new Error('--config is required')
  if (options.screenshots && !options.discover)
    throw new Error('--screenshots needs --discover')
  // The checks below validate the configuration file.
  let config = JSON.parse(await readFile(options.config as string, 'utf8'))
  if (options.cdp) config.cdp = options.cdp
  if (options.page !== undefined) {
    if (!/^\d+$/.test(options.page as string)) throw new Error('Invalid page')
    config.page = Number(options.page)
  }
  if (options['restore-window']) config.restoreWindow = true
  if (options.discover) config = httpDiscoveryConfig(config)
  const directory = await reportFolder(
    'attached',
    options.out as string | undefined,
  )
  const browser = await connectDesktop(config.cdp)
  try {
    const page = selectDesktopPage(browser, config)
    let report: HttpDiscoveryReport | DesktopReport
    if (options.discover) {
      const discovery = await discoverHttp(page, config, {
        screenshot: options.screenshots ? screenshotsIn(directory) : undefined,
      })
      await writeDiscoveryReport(directory, discovery, config)
      report = discovery
    } else {
      const visibility = await prepareVisibility(page, config)
      let check: DesktopReport
      try {
        check = await checkDesktop(page, config)
        check.mode = 'attached browser recovery'
      } finally {
        await visibility.revert()
      }
      await writeDesktopReport(directory, check, config)
      report = check
    }
    if ('findings' in report)
      for (const f of report.findings)
        console.log(
          // A partial finding always carries the interpretation it observed.
          `${f.id}: ${f.classification}${f.partial ? `; runs=${f.completedRuns}/${f.plannedRuns} partial; observed=${f.observedInterpretation!.classification}` : ''}`,
        )
    else for (const r of report.results) console.log(`${r.kind}: ${r.code}`)
    // Only discovery reports carry an error; a check's failures are its rows.
    if ('findings' in report && report.error) console.error(report.error)
    console.log(
      `Final reload: ${report.finalReset}\nReport: ${directory}/report.html`,
    )
    process.exitCode = report.ok
      ? 0
      : 'findings' in report
        ? 2
        : report.results.some((r) => r.outcome === 'fail')
          ? 1
          : 2
  } finally {
    await browser.close()
  }
}
