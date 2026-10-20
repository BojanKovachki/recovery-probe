import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  connectDesktop,
  selectDesktopPage,
  desktopPages,
} from '../dist/desktop.mjs'
import { connectIpcInspector } from '../dist/ipc-inspector.mjs'
import {
  observationConfig,
  runObservation,
  httpObservationAdapter,
  ipcObservationAdapter,
} from '../dist/observe.mjs'
import {
  observationMetadata,
  samplingMetrics,
  observationSummary,
  renderObservationReport,
  actionSummary,
  comparisonDigest,
  networkStepSummary,
} from '../dist/observation-report.mjs'
import { observationSteps, runSteps } from '../dist/observe-steps.mjs'
import { connectNetworkFaults } from '../dist/net-fault.mjs'
import { networkSteps, applyNetworkEvidence } from '../dist/observe-network.mjs'

const USAGE =
  'observe --config FILE [--out NEW_DIRECTORY] [--json] [--interactive] [--steps FILE] [--network URL]'

export async function observeMain(args) {
  if (!args.length || args.includes('--help')) {
    console.log(`recovery-probe ${USAGE}

Observation of an existing browser or Electron renderer.
No reload, navigation, focus change or final UI reset, and no faults except
explicit network steps.
Choose transport: http or ipc and explicit regionSelector/contentSelector CSS markers.
Sampling defaults to detail: "content"; use "region" for full DOM diagnostics.
Navigate manually during the bounded capture. Enter marks a new interval in an
interactive terminal; --interactive also enables newline markers on piped input.
Ctrl+C saves partial evidence. CONTENT_BEFORE_READ and DELAYED_UI_UPDATE are observations, not defects.
--steps runs an explicit, opt-in list of same-document navigations, clicks, waits and
interval marks during the capture. Steps act on the app: use a test account.
--network names a running recovery-probe net, so network steps can fail the app's
own HTTPS connections; they are removed when the capture ends.
IPC requires the observation-capable development hook. See docs/observe.md.`)
    return
  }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (['--json', '--interactive'].includes(args[i]))
      options[args[i].slice(2)] = true
    else if (
      ['--config', '--out', '--steps', '--network'].includes(args[i]) &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      options[args[i].slice(2)] = args[++i]
    else throw Error(`Use ${USAGE}`)
  }
  if (!options.config) throw Error('--config is required')
  const config = observationConfig(
    JSON.parse(await readFile(options.config, 'utf8')),
  )
  const steps = options.steps
    ? observationSteps(JSON.parse(await readFile(options.steps, 'utf8')), {
        network: Boolean(options.network),
      })
    : null
  let network, networkEvidence
  if (options.network) {
    const networkControl = connectNetworkFaults(options.network)
    await networkControl.summary().catch((error) => {
      throw Error(
        `No network control at ${options.network}; start recovery-probe net first (${error.message})`,
        { cause: error },
      )
    })
    network = networkSteps(networkControl)
  }
  let directory
  if (options.out) {
    directory = resolve(options.out)
    await mkdir(directory, { mode: 0o700 })
  } else {
    const parent = resolve('.recovery-probe')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    directory = await mkdtemp(join(parent, 'observe-'))
  }
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  /** @type {Awaited<ReturnType<typeof connectIpcInspector>> | undefined} */
  let control
  /** @type {import('node:readline').Interface | undefined} */
  let input
  let browser,
    report,
    pendingMarkers = 0,
    browserVersion = null
  try {
    browser = await connectDesktop(config.cdp)
    try {
      browserVersion = await browser.version()
    } catch {
      /* Metadata may be unavailable on an attached runtime. */
    }
    let page, adapter
    if (config.transport === 'ipc') {
      control = await connectIpcInspector(config.inspector)
      const identity = await control.call('identify')
      if (!identity.registered.includes(config.channel))
        throw Error(
          'Configured read channel was not registered through the development hook',
        )
      const pages = desktopPages(browser).filter(
        (p) => p.url() === identity.pageUrl,
      )
      if (pages.length !== 1)
        throw Error('Keep exactly one matching IPC target window open')
      page = pages[0]
      const nonce = randomUUID()
      await page.evaluate((value) => {
        if (Object.hasOwn(globalThis, '__recoveryProbeWindowNonce'))
          throw Error('Existing window challenge')
        Object.defineProperty(globalThis, '__recoveryProbeWindowNonce', {
          value,
          configurable: true,
        })
      }, nonce)
      try {
        await control.call('identify', nonce)
      } finally {
        await page.evaluate((value) => {
          if (globalThis.__recoveryProbeWindowNonce === value)
            delete globalThis.__recoveryProbeWindowNonce
        }, nonce)
      }
      adapter = ipcObservationAdapter(control, config, identity.senderId)
    } else {
      page = selectDesktopPage(browser, config)
      adapter = httpObservationAdapter(page, config)
    }
    report = await runObservation(page, config, adapter, {
      signal: abort.signal,
      onReady() {
        if (process.stdin.isTTY || options.interactive) {
          input = createInterface({ input: process.stdin, terminal: false })
          input.on('line', () => {
            pendingMarkers = Math.min(50, pendingMarkers + 1)
          })
          input.on('SIGINT', stop)
        }
        console.error(
          steps
            ? `Observing for ${config.observationMs} ms without reloading. Running ${steps.length} scripted steps; they act on the app. Ctrl+C saves partial evidence.`
            : `Observing for ${config.observationMs} ms without reloading. Navigate in the app now.${input ? ' Press Enter before each action to mark a new interval.' : ''} Ctrl+C saves partial evidence.`,
        )
      },
      takeMarker() {
        if (!pendingMarkers) return false
        pendingMarkers--
        return true
      },
      onInterval() {
        console.error('New observation interval.')
      },
      ...(steps
        ? {
            operator: ({ mark, signal, elapsed }) =>
              runSteps(page, steps, {
                mark,
                signal,
                elapsed,
                network,
                log: (r) =>
                  console.error(
                    `Step ${r.index} ${r.kind}${r.name ? ' ' + r.name : ''}: ${r.status} at ${(r.endedMs / 1000).toFixed(1)} s${r.error ? ' — ' + r.error : ''}`,
                  ),
              }),
          }
        : {}),
    })
  } catch (error) {
    report ??= {
      schemaVersion: 1,
      metadata: observationMetadata(),
      sampling: samplingMetrics(config.sampleMs).snapshot(),
      mode: 'fault-free observation',
      status: 'incomplete',
      captureComplete: false,
      intervals: [],
      findings: [],
      reloads: 0,
      injected: 0,
    }
    report.error = error.message
  } finally {
    if (network) networkEvidence = await network.finish()
    if (input) {
      input.close()
      process.stdin.pause()
    }
    control?.close()
    try {
      await browser?.close()
    } catch (error) {
      report.status = 'incomplete'
      report.captureComplete = false
      report.disconnectError = error.message
    }
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  if (networkEvidence) applyNetworkEvidence(report, networkEvidence)
  report.metadata.browserVersion = browserVersion
  await writeFile(
    join(directory, 'scenario.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  )
  if (steps)
    await writeFile(
      join(directory, 'steps.json'),
      JSON.stringify(steps, null, 2),
      { mode: 0o600 },
    )
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  )
  await writeFile(
    join(directory, 'report.html'),
    renderObservationReport(report),
    { mode: 0o600 },
  )
  if (options.json)
    console.log(
      JSON.stringify({ ...report, reportPath: join(directory, 'report.json') }),
    )
  else {
    for (const i of report.intervals)
      console.log(
        `Interval ${i.index}: ${i.reads?.calls ?? '?'} reads, ${i.reads?.successes ?? '?'} successes, ${i.reads?.errors ?? '?'} errors${i.findings.length ? '; ' + i.findings.join(', ') : ''}`,
      )
    for (const finding of report.findings)
      console.log(
        `Interval ${finding.interval}: ${finding.code === 'DELAYED_UI_UPDATE' ? 'DELAYED_UI_UPDATE — ' : ''}${observationSummary(finding)}`,
      )
    for (const effect of report.actionEffects ?? [])
      console.log(actionSummary(effect))
    for (const line of comparisonDigest(report)) console.log(line)
    for (const note of report.notes ?? []) console.log(`Note: ${note.note}`)
    if (report.operator)
      console.log(
        `Scripted steps: ${report.operator.status}${report.operator.error ? ' — ' + report.operator.error : ''}`,
      )
    for (const record of report.network?.faults ?? [])
      console.log(networkStepSummary(record))
    if (report.network?.restoreError)
      console.error(
        `Network faults were not removed: ${report.network.restoreError}. Stop recovery-probe net to restore the app's network.`,
      )
    console.log(
      `Sampling: ${config.detail}; requested delay ${config.sampleMs} ms; measured mean cadence ${report.sampling.startToStart.meanMs ?? 'unavailable'} ms.`,
    )
    if (report.error) console.error(report.error)
    console.log(
      `Capture: ${report.status} (not a health verdict)\nReport: ${join(directory, 'report.html')}`,
    )
  }
  process.exitCode = report.captureComplete
    ? 0
    : report.status === 'interrupted'
      ? 130
      : 2
}
