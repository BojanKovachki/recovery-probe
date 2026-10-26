import type { Browser, Page } from 'playwright'
import { connectDesktop, selectDesktopPage } from '../../targets/cdp.mjs'
import { attachIpcWindow } from '../../targets/ipc-window.mjs'
import {
  connectIpcInspector,
  type IpcInspector,
} from '../../transports/ipc/inspector.mjs'
import { connectNetworkFaults } from '../../transports/net.mjs'
import {
  httpObservationAdapter,
  ipcObservationAdapter,
  type ObservationAdapter,
} from './adapters.mjs'
import { runObservation, type ObservationHooks } from './capture.mjs'
import type { ObservationConfig } from './config.mjs'
import {
  applyFileFaultEvidence,
  fileFaults,
  type FileFaultEvidence,
} from './file-faults.mjs'
import {
  applyFileEvidence,
  fileEvidence,
  snapshotFiles,
  type FileEvidence,
} from './files.mjs'
import { applyNetworkEvidence, networkSteps } from './network.mjs'
import {
  applyExpectationEvidence,
  observationMetadata,
  samplingMetrics,
  type ObservationReport,
} from './report.mjs'
import { runSteps, type ObservationStep, type StepResult } from './steps.mjs'

type NetworkSteps = ReturnType<typeof networkSteps>

export interface ObserveSessionOptions {
  steps: ObservationStep[] | null
  /** Network steps over a running `recovery-probe net`. */
  network?: NetworkSteps
  /** A directory to compare at each interval; file steps damage files under it. */
  filesDirectory?: string
  signal: AbortSignal
  hooks: Pick<ObservationHooks, 'onReady' | 'takeMarker' | 'onInterval'>
  logStep?: (result: StepResult) => void
}

export interface ObserveSession {
  report: ObservationReport
  /** The private files.json: paths the report leaves out. Set with a files directory. */
  files?: {
    directory: string
    intervals: FileEvidence['paths']
    faults?: FileFaultEvidence['paths']
  }
}

/** Network steps over the `recovery-probe net` at `address`, which must be running. */
export async function connectNetworkSteps(
  address: string,
): Promise<NetworkSteps> {
  const control = connectNetworkFaults(address)
  await control.summary().catch((error) => {
    throw Error(
      `No network control at ${address}; start recovery-probe net first (${error.message})`,
      { cause: error },
    )
  })
  return networkSteps(control)
}

/** What a session attached to, so it can be released whether or not the capture ran. */
interface Target {
  browser?: Browser
  browserVersion: string | null
  control?: IpcInspector
}

type FileRecorder = ReturnType<typeof fileRecorder>

/** Snapshots of `directory` at each interval, and the damage file steps do in it. */
function fileRecorder(
  directory: string | undefined,
  steps: ObservationStep[] | null,
) {
  const snapshots: {
    interval: number
    snapshot: ReturnType<typeof snapshotFiles>
  }[] = []
  return {
    directory,
    snapshots,
    damage:
      directory && steps?.some((step) => step.kind === 'file')
        ? fileFaults(directory)
        : undefined,
    // Started without waiting: walking a large directory must not delay sampling.
    take(interval: number) {
      if (directory)
        snapshots.push({ interval, snapshot: snapshotFiles(directory) })
    },
  }
}

/**
 * Attaches to the configured renderer, runs the capture with any steps, then restores
 * what the steps changed and adds their evidence to the report. A capture that could
 * not start still returns an incomplete report.
 */
export async function observeSession(
  config: ObservationConfig,
  options: ObserveSessionOptions,
): Promise<ObserveSession> {
  const files = fileRecorder(options.filesDirectory, options.steps)
  const target: Target = { browserVersion: null }
  let report: ObservationReport
  try {
    report = await capture(config, target, options, files)
  } catch (error) {
    report = failedReport(config, error as Error)
  }
  const restored = await restore(files, options.network)
  await release(target, report)
  if (restored.network) applyNetworkEvidence(report, restored.network)
  if (restored.faults) applyFileFaultEvidence(report, restored.faults)
  applyExpectationEvidence(report)
  const changes = await fileChanges(report, files, restored.faults)
  // Both the capture and the fallback report carry metadata.
  report.metadata!.browserVersion = target.browserVersion
  return { report, ...changes }
}

async function capture(
  config: ObservationConfig,
  target: Target,
  options: ObserveSessionOptions,
  files: FileRecorder,
): Promise<ObservationReport> {
  const browser = await connectDesktop(config.cdp)
  target.browser = browser
  try {
    target.browserVersion = browser.version()
  } catch {
    /* Metadata may be unavailable on an attached runtime. */
  }
  const { page, adapter } = await selectTarget(config, browser, target)
  return runObservation(page, config, adapter, {
    signal: options.signal,
    takeMarker: options.hooks.takeMarker,
    onReady() {
      files.take(1)
      return options.hooks.onReady?.()
    },
    onInterval(index) {
      files.take(index)
      return options.hooks.onInterval?.(index)
    },
    ...operatorFor(page, options, files),
  })
}

async function selectTarget(
  config: ObservationConfig,
  browser: Browser,
  target: Target,
): Promise<{ page: Page; adapter: ObservationAdapter }> {
  if (config.transport === 'http') {
    const page = selectDesktopPage(browser, config)
    return { page, adapter: httpObservationAdapter(page, config) }
  }
  // IPC observation always has an inspector address after validation.
  const inspector = await connectIpcInspector(config.inspector)
  target.control = inspector
  const ipc = await attachIpcWindow(browser, inspector, [config.channel!])
  return {
    page: ipc.page,
    adapter: ipcObservationAdapter(inspector, config, ipc.identity.senderId),
  }
}

function operatorFor(
  page: Page,
  { steps, network, logStep }: ObserveSessionOptions,
  files: FileRecorder,
): Pick<ObservationHooks, 'operator'> {
  if (!steps) return {}
  return {
    operator: ({ mark, signal, elapsed }) =>
      runSteps(page, steps, {
        mark,
        signal,
        elapsed,
        network,
        files: files.damage,
        log: logStep,
      }),
  }
}

function failedReport(
  config: ObservationConfig,
  error: Error,
): ObservationReport {
  return {
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
    error: error.message,
  }
}

/** Removes the network faults and puts back damaged files, recording the end state first. */
async function restore(files: FileRecorder, network: NetworkSteps | undefined) {
  // Taken before the network and files are restored: the state the capture ended in.
  if (files.snapshots.length) files.take(0)
  const restored: {
    network?: Awaited<ReturnType<NetworkSteps['finish']>>
    faults?: FileFaultEvidence
  } = {}
  if (network) restored.network = await network.finish()
  if (files.damage) {
    await files.snapshots.at(-1)?.snapshot
    restored.faults = await files.damage.finish()
  }
  return restored
}

async function release(target: Target, report: ObservationReport) {
  target.control?.close()
  try {
    await target.browser?.close()
  } catch (error) {
    report.status = 'incomplete'
    report.captureComplete = false
    report.disconnectError = (error as Error).message
  }
}

/** Adds the directory's changes to the report, and returns the paths for files.json. */
async function fileChanges(
  report: ObservationReport,
  files: FileRecorder,
  faults: FileFaultEvidence | undefined,
): Promise<Pick<ObserveSession, 'files'>> {
  if (!files.snapshots.length) return {}
  const evidence = fileEvidence(
    await Promise.all(
      files.snapshots.map(async ({ interval, snapshot }) => ({
        interval,
        snapshot: await snapshot,
      })),
    ),
    // What the steps did to these files is reported on its own.
    files.damage?.damaged(),
  )
  applyFileEvidence(report, evidence)
  return {
    files: {
      directory: files.directory!,
      intervals: evidence.paths,
      ...(faults ? { faults: faults.paths } : {}),
    },
  }
}
