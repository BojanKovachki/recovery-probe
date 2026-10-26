import { signals } from './until-stopped.mjs'
import { writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import {
  observationConfig,
  type ObservationConfig,
} from '../workflows/observe/config.mjs'
import {
  connectNetworkSteps,
  observeSession,
  type ObserveSession,
} from '../workflows/observe/session.mjs'
import {
  observationSummary,
  actionSummary,
  networkStepSummary,
  fileFaultSummary,
} from '../workflows/observe/summaries.mjs'
import { renderObservationReport } from '../workflows/observe/render.mjs'
import type {
  ObservationFinding,
  ObservationInterval,
  ObservationReport,
} from '../workflows/observe/report.mjs'
import { comparisonDigest } from '../workflows/observe/comparisons.mjs'
import {
  observationSteps,
  type ObservationStep,
  type StepResult,
} from '../workflows/observe/steps.mjs'
import { reportFolder } from '../reports/folder.mjs'
import { parseOptions, readConfig, UsageError } from './args.mjs'
import { withEvidence } from '../reports/evidence.mjs'

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

const HELP = `recovery-probe ${USAGE}

Observation of an existing browser or Electron renderer.
No reload, navigation, focus change or final UI reset, and no faults except
explicit network and file steps.
Choose transport: http or ipc and explicit regionSelector/contentSelector CSS markers.
Sampling defaults to detail: "content"; use "region" for full DOM diagnostics.
Navigate manually during the bounded capture. Enter marks a new interval in an
interactive terminal; --interactive also enables newline markers on piped input.
Ctrl+C saves partial evidence. CONTENT_BEFORE_READ and DELAYED_UI_UPDATE are observations, not defects.
UNEXPECTED_ROW_STATE reports a tracked row shown in a state listed in rows.unexpected.
--steps runs an explicit, opt-in list of same-document navigations, clicks, waits,
expectations and interval marks during the capture. Steps act on the app: use a
test account. An expect step that sees nothing in time adds EXPECTATION_NOT_MET.
--network names a running recovery-probe net, so network steps can fail the app's
own HTTPS connections; they are removed when the capture ends.
--files compares a directory's files at each interval and reports files the app
removed or shrank (LOCAL_FILES_REMOVED, a lead). Paths stay in a private files.json.
File steps remove, truncate or corrupt a file under it; a file the app has not
restored by the end adds LOCAL_FILE_NOT_REPAIRED and is put back.
IPC requires the observation-capable development hook. See docs/observe.md.`

// Findings whose code the console names, since their summaries do not.
const NAMED_FINDINGS = [
  'DELAYED_UI_UPDATE',
  'UNEXPECTED_ROW_STATE',
  'LOCAL_FILE_NOT_REPAIRED',
  'EXPECTATION_NOT_MET',
]

export async function observeMain(args: string[]) {
  if (!args.length || args.includes('--help')) {
    console.log(HELP)
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
  const { config, steps, filesDirectory } = await readInputs(options)
  const network = options.network
    ? await connectNetworkSteps(options.network)
    : undefined
  const directory = await reportFolder('observe', options.out)
  const terminal = operatorTerminal(Boolean(options.interactive))
  let session: ObserveSession
  try {
    session = await observeSession(config, {
      steps,
      network,
      filesDirectory,
      signal: terminal.signal,
      hooks: {
        onReady: () =>
          console.error(readyMessage(config, steps, terminal.listen())),
        takeMarker: terminal.takeMarker,
        onInterval: () => console.error('New observation interval.'),
      },
      logStep: (r) => console.error(stepLine(r)),
    })
  } finally {
    terminal.close()
  }
  await writeObservation(directory, config, steps, session)
  const report = session.report
  if (options.json)
    console.log(
      JSON.stringify({ ...report, reportPath: join(directory, 'report.json') }),
    )
  else printObservation(report, config, directory)
  process.exitCode = exitCode(report)
}

function exitCode(report: ObservationReport) {
  if (report.captureComplete) return 0
  return report.status === 'interrupted' ? 130 : 2
}

async function readInputs(options: ObserveOptions) {
  if (!options.config) throw new UsageError('--config is required')
  const config = await readConfig(options.config, observationConfig)
  const steps = options.steps
    ? await readConfig(options.steps, (list) =>
        observationSteps(list, {
          network: Boolean(options.network),
          files: Boolean(options.files),
        }),
      )
    : null
  if (!options.files) return { config, steps }
  const filesDirectory = resolve(options.files)
  if (!(await stat(filesDirectory).catch(() => null))?.isDirectory())
    throw new UsageError('--files must name an existing directory')
  return { config, steps, filesDirectory }
}

/** Ctrl+C stops the capture; Enter marks an interval in a terminal or with --interactive. */
function operatorTerminal(interactive: boolean) {
  const abort = new AbortController()
  const stop = () => abort.abort()
  signals.on('SIGINT', stop)
  signals.on('SIGTERM', stop)
  let input: Interface | undefined
  let pendingMarkers = 0
  return {
    signal: abort.signal,
    /** Starts reading markers; false when input is neither a terminal nor --interactive. */
    listen() {
      if (!process.stdin.isTTY && !interactive) return false
      input = createInterface({ input: process.stdin, terminal: false })
      input.on('line', () => {
        pendingMarkers = Math.min(50, pendingMarkers + 1)
      })
      input.on('SIGINT', stop)
      return true
    },
    takeMarker() {
      if (!pendingMarkers) return false
      pendingMarkers--
      return true
    },
    close() {
      if (input) {
        input.close()
        process.stdin.pause()
      }
      signals.off('SIGINT', stop)
      signals.off('SIGTERM', stop)
    },
  }
}

function readyMessage(
  config: ObservationConfig,
  steps: ObservationStep[] | null,
  marking: boolean,
) {
  const observing = `Observing for ${config.observationMs} ms without reloading.`
  if (steps)
    return `${observing} Running ${steps.length} scripted steps; they act on the app. Ctrl+C saves partial evidence.`
  return `${observing} Navigate in the app now.${marking ? ' Press Enter before each action to mark a new interval.' : ''} Ctrl+C saves partial evidence.`
}

const stepLine = (r: StepResult) =>
  `Step ${r.index} ${r.kind}${r.name ? ' ' + r.name : ''}: ${r.status} at ${((r.endedMs as number) / 1000).toFixed(1)} s${r.error ? ' — ' + r.error : ''}`

async function writeObservation(
  directory: string,
  config: ObservationConfig,
  steps: ObservationStep[] | null,
  { report, files }: ObserveSession,
) {
  const write = (name: string, text: string) =>
    writeFile(join(directory, name), text, { mode: 0o600 })
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  await write('scenario.json', json(config))
  if (files) await write('files.json', json(files))
  if (steps) await write('steps.json', json(steps))
  await write(
    'report.json',
    json(
      withEvidence(report, {
        workflow: 'observe',
        transport: config.transport,
      }),
    ),
  )
  await write('report.html', renderObservationReport(report))
}

function printObservation(
  report: ObservationReport,
  config: ObservationConfig,
  directory: string,
) {
  const lines = [
    ...report.intervals.map(intervalLine),
    ...report.findings.map(findingLine),
    ...(report.actionEffects ?? []).map(actionSummary),
    ...comparisonDigest(report),
    ...(report.notes ?? []).map((note) => `Note: ${note.note}`),
  ]
  for (const line of lines) console.log(line)
  printStepOutcomes(report)
  console.log(
    `Sampling: ${config.detail}; requested delay ${config.sampleMs} ms; measured mean cadence ${report.sampling!.startToStart.meanMs ?? 'unavailable'} ms.`,
  )
  if (report.error) console.error(report.error)
  console.log(
    `Capture: ${report.status} (not a health verdict)\nReport: ${join(directory, 'report.html')}`,
  )
}

function intervalLine({ index, reads, findings }: ObservationInterval) {
  const raised = findings.length ? '; ' + findings.join(', ') : ''
  return `Interval ${index}: ${reads?.calls ?? '?'} reads, ${reads?.successes ?? '?'} successes, ${reads?.errors ?? '?'} errors${raised}`
}

function findingLine(finding: ObservationFinding) {
  const code = NAMED_FINDINGS.includes(finding.code) ? `${finding.code} — ` : ''
  return `Interval ${finding.interval}: ${code}${observationSummary(finding)}`
}

function printStepOutcomes(report: ObservationReport) {
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
  for (const record of report.fileFaults ?? [])
    console.log(fileFaultSummary(record))
}
