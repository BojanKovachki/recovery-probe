import { version } from '../../core/package.mjs'
import type { NetworkRuleSummary } from '../../transports/net.mjs'
import type { ActionEffect } from './action-effects.mjs'
import type { ContentComparison } from './comparisons.mjs'
import type { IntervalFileChanges } from './files.mjs'
import type { SamplingSnapshot } from './sampling.mjs'
import type { FileFault, StepResult } from './steps.mjs'
import { seconds } from './summaries.mjs'

export interface ObservationMetadata {
  recoveryProbeVersion: string
  runtime: { node: string }
  browserVersion: string | null
  ipcHook: { version?: string | null; [key: string]: unknown } | null
}

export interface ReadCounts {
  calls: number
  successes: number
  errors: number
  pending: number
}

export interface ContentSummary {
  count: number
  textFingerprint: string
  truncated: boolean
  [key: string]: unknown
}

/** One completed sample, as the content comparison tracker receives it. */
export interface ObservationSample {
  interval: number
  fromMs: number
  toMs: number
  ui: {
    presence?: string
    visible: boolean
    contentCount?: number
    content?: ContentSummary | null
  }
  reads: ReadCounts & { pendingAtStart: number }
  before: ReadCounts
  after: ReadCounts
}

/** A sample as recorded in the change-only timeline. */
export interface TimelineEvent extends ObservationSample {
  rows?: SummarizedRows
  lastReadAgeMs: number | null
  lastCompletionAgeMs: number | null
  dataEvents?: number
  lastDataEventAgeMs?: number | null
  pageErrors: number
}

/** Row keys are hashed or aliased; states are allowlisted labels, 'none' or 'other'. */
export interface SummarizedRows {
  truncated: boolean
  items: { row: string; state: string }[]
}

export interface ActionRef {
  name: string
  atMs: number
}

export interface ObservedAction extends ActionRef {
  trusted: boolean
  interval: number
}

export interface RowTransition {
  from: string
  to: string
  interval?: number
  afterMs: number
  byMs: number
  afterAction?: ActionRef | null
}

export interface TrackedRow {
  row: string
  firstSeen: {
    interval?: number
    fromMs: number
    toMs: number
    state: string
    afterAction?: ActionRef | null
  }
  transitions: RowTransition[]
  lastState: string
}

export interface ObservationFinding {
  code: string
  kind?: string
  basis: string
  interval: number
  summary?: string
  note?: string
}

export interface DelayedUiUpdateFinding extends ObservationFinding {
  code: 'DELAYED_UI_UPDATE'
  confidence: 'medium' | 'low'
  row: string
  from: string
  to: string
  changedAfterMs: number
  changedByMs: number
  previousStateSinceMs: number
  previousStateStartedAfterActionMs: number | null
  persistedMs: number
  unchangedReadCompletions: number
  dataEventsWhilePersisted: number | null
  sinceLastDataEventMs: number | null
  afterAction: (ActionRef & { changedAfterActionMs: [number, number] }) | null
}

export interface UnexpectedRowStateFinding extends ObservationFinding {
  code: 'UNEXPECTED_ROW_STATE'
  row: string
  state: string
  /** Bounds of the first sample that showed the row in this state. */
  firstSeenMs: [number, number]
  /** End of the last of the consecutive samples that showed it. */
  lastSeenMs: number
  samples: number
  afterAction: (ActionRef & { seenAfterActionMs: [number, number] }) | null
}

export interface ContentBeforeReadFinding extends ObservationFinding {
  code: 'CONTENT_BEFORE_READ'
  fromMs: number
  toMs: number
  reads: ObservationSample['reads']
  lastReadAgeMs: number | null
  lastCompletionAgeMs: number | null
}

export interface ObservationInterval {
  index: number
  startMs: number
  endMs?: number
  startCounts?: ReadCounts
  startChannelCounts?: ReadCounts
  startDataEvents?: number
  firstContent?: {
    fromMs: number
    toMs: number
    [key: string]: unknown
  } | null
  samples: number
  /** Codes of the findings raised in this interval. */
  findings: string[]
  reads?: ObservationSample['reads']
  channelReads?: ObservationSample['reads']
  dataEvents?: number
}

export interface ObservationNote {
  code?: string
  note: string
  [key: string]: unknown
}

export interface ObservationOperator {
  status: string
  error?: string
  steps?: StepResult[]
}

export interface NetworkStepRecord {
  /** Index of the step that armed or restored network faults. */
  step: number
  restored?: true
  /** What the armed rules faulted while they applied; missing when unknown. */
  rules?: NetworkRuleSummary[]
}

export interface ObservationNetwork {
  faults: NetworkStepRecord[]
  /** Why the faults could not be removed at the end. */
  restoreError?: string
}

/** What became of a damaged file by the end of the capture. */
export type FileFaultOutcome =
  /** The app put the original content back. */
  | 'repaired'
  /** The file was as the step left it. */
  | 'damaged'
  /** The app changed or removed it, but it did not hold the original content. */
  | 'changed'

export interface FileFaultRecord {
  /** Index of the step that damaged the file. */
  step: number
  fault: FileFault
  outcome?: FileFaultOutcome
  /** Recovery Probe put the original back, because the app had not. */
  restored?: true
  /** The error code, such as `EBUSY`, when the file could not be checked or put back; its original is kept. */
  error?: string
}

/** The index of the interval that was open at `ms` into the capture. */
export const intervalAt = (
  report: Pick<ObservationReport, 'intervals'>,
  ms: number,
): number =>
  (
    [...report.intervals].reverse().find((i) => i.startMs <= ms) ??
    report.intervals[0]
  )?.index ?? 1

/** Adds an `EXPECTATION_NOT_MET` finding for each `expect` step that saw no visible match in time. */
export function applyExpectationEvidence(report: ObservationReport): void {
  for (const step of report.operator?.steps ?? []) {
    if (step.status !== 'unmet') continue
    const interval = intervalAt(report, step.startedMs)
    const waited = (step.endedMs ?? step.startedMs) - step.startedMs
    report.findings.push({
      code: 'EXPECTATION_NOT_MET',
      basis: 'SCRIPTED_EXPECTATION',
      interval,
      summary: `Step ${step.index} (expect${step.name ? ` ‘${step.name}’` : ''}) saw no visible match in ${seconds(waited)} s.`,
    })
    report.intervals
      .find((i) => i.index === interval)
      ?.findings.push('EXPECTATION_NOT_MET')
  }
}

/** An observation report. Optional fields may be missing from older or failed captures. */
export interface ObservationReport {
  schemaVersion?: number
  metadata?: ObservationMetadata
  mode?: string
  transport?: string
  target?: string
  targetMethods?: string[]
  generatedAt?: string
  status: string
  captureComplete?: boolean
  observationMs?: number
  sampleMs?: number
  detail?: string
  startedAt?: number
  elapsedMs?: number
  samples?: number
  sampling?: SamplingSnapshot | null
  limitation?: string
  error?: string
  intervals: ObservationInterval[]
  findings: ObservationFinding[]
  comparisons?: ContentComparison[]
  timeline?: TimelineEvent[]
  actions?: ObservedAction[]
  actionEffects?: ActionEffect[]
  rows?: TrackedRow[] | null
  notes?: ObservationNote[]
  operator?: ObservationOperator | null
  network?: ObservationNetwork
  /** What changed on disk in each interval, from `observe --files`. */
  files?: { intervals: IntervalFileChanges[] }
  /** What became of each file a step damaged. */
  fileFaults?: FileFaultRecord[]
  injected?: number
  reloads?: number
  cleanup?: string
  cleanupEvidence?: Record<string, unknown> | null
  cleanupError?: string
  /** Set by the CLI when closing the browser connection failed. */
  disconnectError?: string
  coverage?: {
    historyBeforeCapture: string
    pendingBeforeCapture: string
    scope: string
    gaps: string[]
  }
  snapshot?: unknown
  snapshotStage?: string
}

export function observationMetadata(): ObservationMetadata {
  return {
    recoveryProbeVersion: version,
    runtime: { node: process.versions.node },
    browserVersion: null,
    ipcHook: null,
  }
}
