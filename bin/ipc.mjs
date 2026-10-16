import { writeDiscoveryReport } from '../dist/discovery-report.mjs'
import { writeActionReport } from '../dist/action-report.mjs'
import { actionConfig, checkAction } from '../dist/ipc-action.mjs'
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { discoverIpc, discoveryConfig } from '../dist/ipc-discover.mjs'
import { checkIpc } from '../dist/ipc-check.mjs'
import { renderTemplate } from '../dist/report-template.mjs'

export async function ipcMain(args) {
  if (!args.length || args.includes('--help')) {
    console.log(`Recovery Probe IPC preview
  recovery-probe ipc --config ipc-scenario.json [--out NEW_DIRECTORY] [--discover | --action]

Requires a development-only main-process registration hook and two loopback ports:
Electron CDP (usually 9222) and Node inspector (usually 9229).
Default: verify one IPC rejection; null-result is explicitly optional.
--discover: compare healthy controls with single/double rejection and null-result experiments.
Discovery uses structural comparisons and language hints; findings require review. No readiness selector needed.
--action: run scripted setup steps, then click the action while the hook answers its write channel:
  a simulated success, a simulated failure and a double-click. Nothing is written.
No HTTP/Rust transport faults or AI calls. See docs/ipc.md for installation and scope.`)
    return
  }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--restore-window') {
      options.restoreWindow = true
      continue
    }
    if (args[i] === '--discover' || args[i] === '--action') {
      options[args[i].slice(2)] = true
      continue
    }
    if (
      !['--config', '--out'].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error(
        'Use ipc --config FILE [--out NEW_DIRECTORY] [--discover | --action]',
      )
    options[args[i].slice(2)] = args[++i]
  }
  if (!options.config) throw new Error('--config is required')
  if (options.discover && options.action)
    throw new Error('Use either --discover or --action')
  const rawConfig = JSON.parse(await readFile(options.config, 'utf8'))
  if (options.restoreWindow) rawConfig.restoreWindow = true
  const config = options.discover
    ? discoveryConfig(rawConfig)
    : options.action
      ? actionConfig(rawConfig)
      : rawConfig
  const parent = resolve('.recovery-probe')
  let directory
  if (options.out) {
    directory = resolve(options.out)
    await mkdir(directory, { mode: 0o700 })
  } else {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    directory = await mkdtemp(join(parent, 'ipc-'))
  }
  if (options.action) {
    // checkAction validates the raw config itself; the early validation above only fails fast.
    const report = await checkAction(rawConfig)
    await writeActionReport(directory, report, rawConfig)
    for (const finding of report.findings)
      console.log(
        `${finding.kind.toUpperCase()}: ${finding.id} — ${finding.classification}`,
      )
    if (report.error) console.error(`Action check stopped: ${report.error}`)
    if (report.cleanupError) console.error(`Cleanup: ${report.cleanupError}`)
    console.log(
      `Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}`,
    )
    process.exitCode = report.ok ? 0 : 2 // Heuristic findings are leads, not proven failures.
    return
  }
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  const report = options.discover
    ? await discoverIpc(config)
    : await checkIpc(config)
  await writeFile(
    join(directory, 'scenario.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  )
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  )
  const html = renderTemplate('ipc', {
    heading: report.ok
      ? 'Selected IPC experiments completed without findings requiring review'
      : 'IPC recovery needs investigation',
    limitation: report.limitation,
    finalReset: report.finalReset,
    evidence: JSON.stringify(report, null, 2),
  })
  await writeFile(join(directory, 'report.html'), html, { mode: 0o600 })
  if ('findings' in report) {
    await writeDiscoveryReport(directory, report, config)
    for (const finding of report.findings)
      console.log(
        `${finding.kind.toUpperCase()}: ${finding.id} — ${finding.classification}; runs=${finding.confirmations}${finding.partial ? `/${finding.plannedRuns} partial; observed=${finding.observedInterpretation.classification}` : ''}`,
      )
    if (report.error) console.error(`Discovery stopped: ${report.error}`)
    if (report.cleanupError) console.error(`Cleanup: ${report.cleanupError}`)
    console.log(
      `Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}\nReplay: recovery-probe ipc --discover --config ${join(directory, 'scenario.json')}`,
    )
    process.exitCode = report.ok ? 0 : 2 // Heuristic findings are never proven test failures.
    return
  }
  console.log(
    `Baseline: ${report.baseline?.code ?? report.error ?? 'not established'}`,
  )
  for (const row of report.results)
    console.log(
      `${row.outcome.toUpperCase()}: ${row.fault} — ${row.code}; injected=${row.snapshot.injected}; later real successes=${row.snapshot.successfulAfterFault}`,
    )
  if (report.error) console.error(`Check stopped: ${report.error}`)
  if (report.cleanupError) console.error(`Cleanup: ${report.cleanupError}`)
  console.log(
    `Final reload: ${report.finalReset}\nReport: ${join(directory, 'report.html')}`,
  )
  process.exitCode = report.ok
    ? 0
    : report.results.some((row) => row.outcome === 'fail')
      ? 1
      : 2
}
