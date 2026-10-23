import { signals } from './until-stopped.mjs'
import { writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Browser, Page } from 'playwright'
import { connectDesktop, selectDesktopPage } from '../targets/cdp.mjs'
import {
  connectIpcInspector,
  type IpcInspector,
} from '../transports/ipc/inspector.mjs'
import {
  observationConfig,
  runObservation,
  httpObservationAdapter,
  ipcObservationAdapter,
} from '../workflows/observe/run.mjs'
import {
  observationMetadata,
  samplingMetrics,
  observationSummary,
  renderObservationReport,
  type ObservationReport,
  actionSummary,
  comparisonDigest,
  networkStepSummary,
} from '../workflows/observe/report.mjs'
import { observationSteps, runSteps } from '../workflows/observe/steps.mjs'
import { connectNetworkFaults } from '../transports/net.mjs'
import {
  networkSteps,
  applyNetworkEvidence,
} from '../workflows/observe/network.mjs'
import {
  snapshotFiles,
  fileEvidence,
  applyFileEvidence,
} from '../workflows/observe/files.mjs'
import { attachIpcWindow } from '../targets/ipc-window.mjs'
import { reportFolder } from '../reports/folder.mjs'
import { parseOptions, readConfig, UsageError } from './args.mjs'
import { withEvidence } from '../reports/evidence.mjs'

type NetworkSteps = ReturnType<typeof networkSteps>
type ObservationAdapter = Parameters<typeof runObservation>[2]

interface ObserveOptions {
  json?: boolean
  interactive?: boolean
  config?: string
  out?: string
  steps?: string
  network?: string
  files?: string
}

const USAGE =
  'observe --config FILE [--out NEW_DIRECTORY] [--json] [--interactive] [--steps FILE] [--network URL] [--files DIR]'

export async function observeMain(args: string[]) {
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
UNEXPECTED_ROW_STATE reports a tracked row shown in a state listed in rows.unexpected.
--steps runs an explicit, opt-in list of same-document navigations, clicks, waits and
interval marks during the capture. Steps act on the app: use a test account.
--network names a running recovery-probe net, so network steps can fail the app's
own HTTPS connections; they are removed when the capture ends.
--files compares a directory's files at each interval and reports files the app
removed or shrank (LOCAL_FILES_REMOVED, a lead). Paths stay in a private files.json.
IPC requires the observation-capable development hook. See docs/observe.md.`)
    return
  }
  const { values } = parseOptions(args, {
    config: { type: 'string' },
    out: { type: 'string' },
    steps: { type: 'string' },
    network: { type: 'string' },
    files: { type: 'string' },
    json: { type: 'boolean' },
    interactive: { type: 'boolean' },
  })
  const options = values as ObserveOptions
  if (!options.config) throw new UsageError('--config is required')
  const config = await readConfig(options.config, observationConfig)
  const steps = options.steps
    ? await readConfig(options.steps, (list) =>
        observationSteps(list, { network: Boolean(options.network) }),
      )
    : null
  let filesDirectory: string | undefined
  const fileSnapshots: {
    interval: number
    snapshot: ReturnType<typeof snapshotFiles>
  }[] = []
  if (options.files) {
    filesDirectory = resolve(options.files)
    if (!(await stat(filesDirectory).catch(() => null))?.isDirectory())
      throw new UsageError('--files must name an existing directory')
  }
  // Started without waiting: walking a large directory must not delay sampling.
  const takeFileSnapshot = (interval: number) => {
    if (filesDirectory)
      fileSnapshots.push({ interval, snapshot: snapshotFiles(filesDirectory) })
  }
  let network: NetworkSteps | undefined
  let networkEvidence: Awaited<ReturnType<NetworkSteps['finish']>> | undefined
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
  const directory = await reportFolder('observe', options.out)
  const abort = new AbortController()
  const stop = () => abort.abort()
  signals.on('SIGINT', stop)
  signals.on('SIGTERM', stop)
  let control: IpcInspector | undefined
  let input: Interface | undefined
  let browser: Browser | undefined,
    report: ObservationReport | undefined,
    pendingMarkers = 0,
    browserVersion: string | null = null
  try {
    const attached = await connectDesktop(config.cdp)
    browser = attached
    try {
      browserVersion = attached.version()
    } catch {
      /* Metadata may be unavailable on an attached runtime. */
    }
    let page: Page, adapter: ObservationAdapter
    if (config.transport === 'ipc') {
      // IPC observation always has an inspector address after validation.
      const inspector = await connectIpcInspector(config.inspector as string)
      control = inspector
      const ipc = await attachIpcWindow(attached, inspector, [
        config.channel as string,
      ])
      page = ipc.page
      adapter = ipcObservationAdapter(inspector, config, ipc.identity.senderId)
    } else {
      page = selectDesktopPage(attached, config)
      adapter = httpObservationAdapter(page, config)
    }
    report = await runObservation(page, config, adapter, {
      signal: abort.signal,
      onReady() {
        takeFileSnapshot(1)
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
      onInterval(index) {
        takeFileSnapshot(index)
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
                    `Step ${r.index} ${r.kind}${r.name ? ' ' + r.name : ''}: ${r.status} at ${((r.endedMs as number) / 1000).toFixed(1)} s${r.error ? ' — ' + r.error : ''}`,
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
    report.error = (error as Error).message
  } finally {
    // The capture or its catch has set the report by now.
    const current = report!
    // Taken before the network is restored: the state the capture ended in.
    if (fileSnapshots.length) takeFileSnapshot(0)
    if (network) networkEvidence = await network.finish()
    if (input) {
      input.close()
      process.stdin.pause()
    }
    control?.close()
    try {
      await browser?.close()
    } catch (error) {
      current.status = 'incomplete'
      current.captureComplete = false
      current.disconnectError = (error as Error).message
    }
    signals.off('SIGINT', stop)
    signals.off('SIGTERM', stop)
  }
  if (networkEvidence) applyNetworkEvidence(report, networkEvidence)
  let filePaths
  if (fileSnapshots.length) {
    const evidence = fileEvidence(
      await Promise.all(
        fileSnapshots.map(async ({ interval, snapshot }) => ({
          interval,
          snapshot: await snapshot,
        })),
      ),
    )
    applyFileEvidence(report, evidence)
    filePaths = evidence.paths
  }
  // Both the capture and the fallback report carry metadata.
  report.metadata!.browserVersion = browserVersion
  await writeFile(
    join(directory, 'scenario.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  )
  if (filePaths)
    await writeFile(
      join(directory, 'files.json'),
      JSON.stringify(
        { directory: filesDirectory, intervals: filePaths },
        null,
        2,
      ),
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
    JSON.stringify(
      withEvidence(report, {
        workflow: 'observe',
        transport: config.transport,
      }),
      null,
      2,
    ),
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
        `Interval ${finding.interval}: ${['DELAYED_UI_UPDATE', 'UNEXPECTED_ROW_STATE'].includes(finding.code) ? `${finding.code} — ` : ''}${observationSummary(finding)}`,
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
      `Sampling: ${config.detail}; requested delay ${config.sampleMs} ms; measured mean cadence ${report.sampling!.startToStart.meanMs ?? 'unavailable'} ms.`,
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
