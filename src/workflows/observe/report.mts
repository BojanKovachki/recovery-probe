import { version } from '../../core/package.mjs'
import { escapeHtml, renderTemplate } from '../../reports/template.mjs'
import type { NetworkRuleSummary } from '../../transports/net.mjs'
import type { IntervalFileChanges } from './files.mjs'
import type { FileFault, StepResult } from './steps.mjs'

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

export type ComparisonResult = 'unavailable' | 'unchanged' | 'changed'
export type ComparisonBasis = 'READ_COMPLETION' | 'INTERVAL_RETURN'

interface ContentEvidence {
  interval: number
  fromMs: number
  toMs: number
  presence?: string
  visible: boolean
  content: ContentSummary | null
}

export interface ComparisonFollowUp {
  samples: number
  comparableSamples: number
  unavailableSamples: number
  firstBaselineMatch: ContentEvidence | null
  latest: (ContentEvidence & { result: ComparisonResult }) | null
  summary: string
}

export interface ContentComparison {
  kind: 'observation'
  basis: ComparisonBasis
  interval: number
  result: ComparisonResult
  before: ContentEvidence
  after: ContentEvidence
  completions?: { successes: number; errors: number }
  reads?: ObservationSample['reads']
  summary: string
  note: string
  followUp?: ComparisonFollowUp
}

interface PhaseStats {
  count: number
  meanMs: number | null
  minMs: number | null
  maxMs: number | null
}

export interface SamplingSnapshot {
  requestedDelayMs: number
  completedSamples: number
  sampleDuration: PhaseStats
  startToStart: PhaseStats
  phases: Record<string, PhaseStats>
  note: string
}

const samplingPhases = [
  'beforeSnapshotMs',
  'uiRoundTripMs',
  'rendererReadMs',
  'summarizeMs',
  'afterSnapshotMs',
] as const

export type SamplingTimings = Partial<
  Record<(typeof samplingPhases)[number], number>
>

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

export interface ActionEffect extends ObservedAction {
  appeared: {
    row: string
    state: string
    appearedAfterMs: [number, number]
    changes: { from: string; to: string; afterActionMs: [number, number] }[]
  }[]
  changed: {
    row: string
    from: string
    to: string
    afterActionMs: [number, number]
  }[]
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

export const networkStepSummary = (record: NetworkStepRecord): string => {
  if (record.restored) return `Step ${record.step}: network restored`
  if (!record.rules)
    return `Step ${record.step}: network faults armed; what they faulted is unknown`
  return record.rules
    .map(
      (rule) =>
        `Step ${record.step}: ${rule.fault} ${rule.host} faulted ${rule.applied} of ${rule.matching} matching connection(s)`,
    )
    .join('; ')
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

export const DAMAGED: Record<FileFault, string> = {
  remove: 'removed',
  truncate: 'truncated',
  corrupt: 'corrupted',
}

export function fileFaultSummary(record: FileFaultRecord): string {
  const damaged = DAMAGED[record.fault]
  const putBack = record.restored ? '; Recovery Probe put it back' : ''
  if (record.error)
    return `Step ${record.step}: the ${damaged} file could not be checked or put back (${record.error}); its original is kept, see files.json`
  if (record.outcome === 'repaired')
    return `Step ${record.step}: the app restored the file the step ${damaged}`
  if (record.outcome === 'damaged')
    return `Step ${record.step}: the file the step ${damaged} was still ${record.fault === 'remove' ? 'missing' : damaged} when the capture ended${putBack}`
  return `Step ${record.step}: the app changed the file the step ${damaged}, but it did not hold the original content when the capture ended${putBack}`
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

// Aggregate every completed sample, including samples omitted from the change-only timeline.
export function samplingMetrics(requestedDelayMs: number) {
  let previous: number | undefined,
    count = 0,
    sum = 0,
    min = Infinity,
    max = 0
  let gaps = 0,
    gapSum = 0,
    gapMin = Infinity,
    gapMax = 0
  const phases: Record<
    string,
    { count: number; sum: number; min: number; max: number }
  > = {}
  return {
    add(fromMs: number, toMs: number, timings: SamplingTimings = {}) {
      const duration = toMs - fromMs
      count++
      sum += duration
      min = Math.min(min, duration)
      max = Math.max(max, duration)
      if (previous !== undefined) {
        const gap = fromMs - previous
        gaps++
        gapSum += gap
        gapMin = Math.min(gapMin, gap)
        gapMax = Math.max(gapMax, gap)
      }
      previous = fromMs
      for (const key of samplingPhases) {
        const value = timings[key]
        if (value === undefined || !Number.isFinite(value) || value < 0)
          continue
        const p = (phases[key] ??= { count: 0, sum: 0, min: Infinity, max: 0 })
        p.count++
        p.sum += value
        p.min = Math.min(p.min, value)
        p.max = Math.max(p.max, value)
      }
    },
    snapshot(): SamplingSnapshot {
      const round = (n: number) => Math.round(n * 100) / 100
      const stats = (
        n: number,
        total: number,
        low: number,
        high: number,
      ): PhaseStats => ({
        count: n,
        meanMs: n ? round(total / n) : null,
        minMs: n ? round(low) : null,
        maxMs: n ? round(high) : null,
      })
      return {
        requestedDelayMs,
        completedSamples: count,
        sampleDuration: stats(count, sum, min, max),
        startToStart: stats(gaps, gapSum, gapMin, gapMax),
        phases: Object.fromEntries(
          Object.entries(phases).map(([key, p]) => [
            key,
            stats(p.count, p.sum, p.min, p.max),
          ]),
        ),
        note: 'The configured delay follows each completed sample. Sample duration brackets the UI read and following counter snapshot; cadence also includes other protocol work. These are completed-sample measurements, not guaranteed temporal coverage.',
      }
    },
  }
}

// Compare samples only; these summaries cannot establish ownership or freshness.
const contentEvidence = (e: ObservationSample): ContentEvidence => ({
  interval: e.interval,
  fromMs: e.fromMs,
  toMs: e.toMs,
  presence: e.ui.presence,
  visible: e.ui.visible,
  content: e.ui.content ?? null,
})
function compareContent(
  before: ContentEvidence,
  after: ContentEvidence,
): ComparisonResult {
  const a = before.content,
    b = after.content
  const comparable =
    before.visible && after.visible && a && b && !a.truncated && !b.truncated
  return !comparable
    ? 'unavailable'
    : a.count === b.count && a.textFingerprint === b.textFingerprint
      ? 'unchanged'
      : 'changed'
}

export function contentComparison(
  basis: ComparisonBasis,
  before: ObservationSample,
  after: ObservationSample,
): ContentComparison {
  const result = compareContent(contentEvidence(before), contentEvidence(after))
  return {
    kind: 'observation',
    basis,
    interval: after.interval,
    result,
    before: contentEvidence(before),
    after: contentEvidence(after),
    ...(basis === 'READ_COMPLETION'
      ? {
          completions: {
            successes: after.before.successes - before.after.successes,
            errors: after.before.errors - before.after.errors,
          },
        }
      : { reads: after.reads }),
    summary: `${basis === 'READ_COMPLETION' ? 'Across observed read completion(s)' : 'On the first sampled content in this interval'}, selected marker text/count comparison: ${result}.`,
    note: 'Ordered normalized visible marker text/count only. Other values, ownership, freshness and changes between samples are unknown. Completion does not imply renderer consumption.',
  }
}

export function comparisonFollowUpSummary(comparison: {
  result?: ComparisonResult
  followUp?: ComparisonFollowUp
}): string {
  const f = comparison.followUp
  if (!f) return '' // Reports from older versions have no follow-up evidence.
  if (!f.samples || !f.latest) return 'No later sample in this interval.'
  const matched = f.firstBaselineMatch
  const prefix =
    comparison.result === 'changed' && matched
      ? `Initially different; a later sample matched the baseline (${matched.fromMs}–${matched.toMs} ms from capture start). `
      : ''
  return `${prefix}Latest follow-up sample (${f.latest.fromMs}–${f.latest.toMs} ms from capture start): ${f.latest.result} against the baseline. ${f.comparableSamples} comparable, ${f.unavailableSamples} unavailable later samples. These samples do not establish continuous visibility or stability.`
}

type TrackedComparison = ContentComparison & { followUp: ComparisonFollowUp }

export function contentComparisons() {
  let interval: number | undefined,
    anchor: ObservationSample | undefined,
    lastContent: ObservationSample | undefined,
    returnBaseline: ObservationSample | undefined,
    comparedReturn = false
  let active: TrackedComparison[] = [],
    retained = 0
  const completed = (counts: ReadCounts) => counts.successes + counts.errors
  return {
    add(event: ObservationSample): ContentComparison[] {
      const results: ContentComparison[] = []
      if (interval !== event.interval) {
        interval = event.interval
        anchor = undefined
        returnBaseline = lastContent
        comparedReturn = false
        active = [] // Later intervals cannot resolve an earlier comparison.
      }
      for (const comparison of active) {
        const f = comparison.followUp
        const evidence = contentEvidence(event)
        const result = compareContent(comparison.before, evidence)
        f.samples++
        if (result === 'unavailable') f.unavailableSamples++
        else f.comparableSamples++
        f.latest = { ...evidence, result }
        if (result === 'unchanged' && !f.firstBaselineMatch)
          f.firstBaselineMatch = evidence
        f.summary = comparisonFollowUpSummary(comparison)
      }
      if (event.ui.visible && (event.ui.contentCount ?? 0) > 0) {
        if (returnBaseline && !comparedReturn)
          results.push(
            contentComparison('INTERVAL_RETURN', returnBaseline, event),
          )
        comparedReturn = true
        lastContent = event
      }
      if (anchor && completed(event.after) > completed(anchor.after)) {
        // A completion during the UI read is ambiguous. Retain the earlier
        // sample until a later UI read is bracketed by settled counters.
        if (completed(event.before) === completed(event.after)) {
          results.push(contentComparison('READ_COMPLETION', anchor, event))
          anchor = event
        }
      } else anchor = event
      for (const comparison of results) {
        // Match the report's global comparison cap; do not retain discarded evidence.
        if (retained >= 1000) break
        const tracked: TrackedComparison = Object.assign(comparison, {
          followUp: {
            samples: 0,
            comparableSamples: 0,
            unavailableSamples: 0,
            firstBaselineMatch: null,
            latest: null,
            summary: 'No later sample in this interval.',
          },
        })
        retained++
        active.push(tracked)
      }
      return results
    },
  }
}

const seconds = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1)
const range = ([low, high]: readonly [number, number]) => {
  const a = seconds(Math.max(0, low)),
    b = seconds(high)
  return a === b ? `about ${a} s` : `${a}–${b} s`
}
const rowName = (row: string) =>
  row.startsWith('key:') ? `row ${row.slice(4, 12)}` : `row ‘${row}’`
const capitalizedRowName = (row: string) =>
  rowName(row)[0].toUpperCase() + rowName(row).slice(1)

const isDelayedUiUpdate = (
  finding: ObservationFinding,
): finding is DelayedUiUpdateFinding => finding.code === 'DELAYED_UI_UPDATE'

const isUnexpectedRowState = (
  finding: ObservationFinding,
): finding is UnexpectedRowStateFinding =>
  finding.code === 'UNEXPECTED_ROW_STATE'

export function observationSummary(finding: ObservationFinding): string {
  if (isDelayedUiUpdate(finding)) {
    const data =
      finding.basis === 'NO_DATA_EVENT_BEFORE_UI_CHANGE'
        ? `; no data event arrived in the change window${finding.sinceLastDataEventMs === null ? '' : ` (the last one was ${seconds(finding.sinceLastDataEventMs)} s earlier)`}`
        : '; data events were not observed for this target'
    const action = finding.afterAction
      ? ` The change came ${range(finding.afterAction.changedAfterActionMs)} after action ‘${finding.afterAction.name}’${finding.previousStateStartedAfterActionMs == null ? '; the earlier state did not start right after an action' : '; the earlier state started right after it'}.`
      : ''
    return `${capitalizedRowName(finding.row)} stayed ${finding.from} for ${seconds(finding.persistedMs)} s across ${finding.unchangedReadCompletions} completed selected reads, then changed to ${finding.to}${data}.${action}`
  }
  if (isUnexpectedRowState(finding)) {
    const action = finding.afterAction
      ? `; first seen ${range(finding.afterAction.seenAfterActionMs)} after action ‘${finding.afterAction.name}’`
      : ''
    return `${capitalizedRowName(finding.row)} showed ${finding.state}, which this region must not show, in ${finding.samples} sample${finding.samples === 1 ? '' : 's'} from ${range(finding.firstSeenMs)} to ${seconds(finding.lastSeenMs)} s${action}.`
  }
  // These are summarized where they are found.
  if (
    [
      'LOCAL_FILES_REMOVED',
      'LOCAL_FILE_NOT_REPAIRED',
      'EXPECTATION_NOT_MET',
    ].includes(finding.code) &&
    finding.summary
  )
    return finding.summary
  if (finding.basis === 'NO_READ_OBSERVED_IN_INTERVAL')
    return 'Content was visible without a new selected read in this interval.'
  if (finding.basis === 'NO_COMPLETION_OBSERVED_IN_INTERVAL')
    return 'Content was visible before any selected read completed in this interval (a read was pending or had started).'
  return 'Content/read ordering was observed; inspect the evidence.'
}

/** Rows that appeared or changed after each configured action, relative to the action time. */
export function actionEffects(report: {
  actions?: ObservedAction[] | null
  rows?: TrackedRow[] | null
}): ActionEffect[] {
  const actions = report.actions ?? []
  const same = (ref: ActionRef | null | undefined, action: ObservedAction) =>
    ref != null && ref.name === action.name && ref.atMs === action.atMs
  return actions.map((action) => {
    const appeared = (report.rows ?? [])
      .filter((r) => same(r.firstSeen.afterAction, action))
      .map((r) => ({
        row: r.row,
        state: r.firstSeen.state,
        appearedAfterMs: [
          r.firstSeen.fromMs - action.atMs,
          r.firstSeen.toMs - action.atMs,
        ] as [number, number],
        changes: r.transitions
          .filter((t) => same(t.afterAction, action))
          .map((t) => ({
            from: t.from,
            to: t.to,
            afterActionMs: [t.afterMs - action.atMs, t.byMs - action.atMs] as [
              number,
              number,
            ],
          })),
      }))
    const changed = (report.rows ?? [])
      .filter((r) => !same(r.firstSeen.afterAction, action))
      .flatMap((r) =>
        r.transitions
          .filter((t) => same(t.afterAction, action))
          .map((t) => ({
            row: r.row,
            from: t.from,
            to: t.to,
            afterActionMs: [t.afterMs - action.atMs, t.byMs - action.atMs] as [
              number,
              number,
            ],
          })),
      )
    return { ...action, appeared, changed }
  })
}

export function actionSummary(effect: ActionEffect): string {
  // Rows without a tracked state that merely appeared (for example after navigating) are counted, not listed.
  const quiet = effect.appeared.filter(
    (a) => ['none', 'other'].includes(a.state) && !a.changes.length,
  )
  const parts = effect.appeared
    .filter((a) => !quiet.includes(a))
    .map(
      (a) =>
        `${rowName(a.row)} appeared ${range(a.appearedAfterMs)} later as ${a.state}${a.changes.map((c) => `, then ${c.from} → ${c.to} ${range(c.afterActionMs)} after the action`).join('')}`,
    )
  parts.push(
    ...effect.changed.map(
      (c) =>
        `${rowName(c.row)} changed ${c.from} → ${c.to} ${range(c.afterActionMs)} after the action`,
    ),
  )
  if (quiet.length)
    parts.push(
      `${quiet.length} row${quiet.length === 1 ? '' : 's'} without a tracked state appeared`,
    )
  return `Action ‘${effect.name}’ at ${seconds(effect.atMs)} s (${effect.trusted ? 'trusted input' : 'scripted, untrusted event'}): ${parts.length ? parts.join('; ') : 'no tracked row appeared or changed'}.`
}

/** One line per interval instead of one per comparison. */
export function comparisonDigest(report: {
  comparisons?: ContentComparison[]
}): string[] {
  const byInterval = new Map<number, Record<string, number>>()
  for (const c of report.comparisons ?? []) {
    const entry = byInterval.get(c.interval) ?? {}
    const key = `${c.basis === 'READ_COMPLETION' ? 'read-completion' : 'interval-return'} ${c.result}${c.basis === 'INTERVAL_RETURN' && c.result === 'changed' && c.followUp?.firstBaselineMatch ? ' (later matched)' : ''}`
    entry[key] = (entry[key] ?? 0) + 1
    byInterval.set(c.interval, entry)
  }
  return [...byInterval].map(
    ([index, entry]) =>
      `Interval ${index} comparisons: ${Object.entries(entry)
        .map(([key, n]) => `${n} ${key}`)
        .join(', ')}.`,
  )
}

const trackedRowHtml = (r: TrackedRow) => {
  const changes = r.transitions
    .map(
      (t) =>
        `${escapeHtml(t.from)} → ${escapeHtml(t.to)} at ${seconds(t.afterMs)}–${seconds(t.byMs)} s`,
    )
    .join('<br>')
  return `<tr><td>${escapeHtml(rowName(r.row))}</td><td>${seconds(r.firstSeen.fromMs)}–${seconds(r.firstSeen.toMs)} s as ${escapeHtml(r.firstSeen.state)}</td><td>${changes || 'none'}</td><td>${escapeHtml(r.lastState)}</td></tr>`
}

export function renderObservationReport(report: ObservationReport): string {
  const intervals = report.intervals
    .map(
      (i) =>
        `<tr><td>${i.index}</td><td>${i.reads?.calls ?? 'unknown'}</td><td>${i.reads?.successes ?? 'unknown'}</td><td>${i.reads?.errors ?? 'unknown'}</td><td>${i.firstContent ? `${i.firstContent.fromMs - i.startMs}–${i.firstContent.toMs - i.startMs} ms` : 'not sampled'}</td></tr>`,
    )
    .join('')
  const sampling = report.sampling
  const comparisons = (report.comparisons ?? [])
    .map(
      (c) =>
        `<p>Interval ${escapeHtml(c.interval)}: ${escapeHtml(c.summary)} ${c.completions ? `(${c.completions.successes} successful, ${c.completions.errors} failed read completions)` : `(${c.reads?.calls} selected reads started in this interval)`} ${escapeHtml(comparisonFollowUpSummary(c))}</p>`,
    )
    .join('')
  const phaseRows = Object.entries(sampling?.phases ?? {})
    .map(
      ([name, s]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${s.meanMs}</td><td>${s.maxMs}</td></tr>`,
    )
    .join('')
  const effects = report.actionEffects ?? []
  const actionsHtml = effects.length
    ? `<h2>Actions</h2>${effects.map((e) => `<p>${escapeHtml(actionSummary(e))}</p>`).join('')}`
    : ''
  const trackedRows = report.rows?.length
    ? `<h2>Tracked rows</h2><table><thead><tr><th>Row</th><th>First seen</th><th>State changes</th><th>Last state</th></tr></thead><tbody>${report.rows.map(trackedRowHtml).join('')}</tbody></table><p>Row keys are hashed unless an alias was configured. A configured marker names the state; otherwise text outside the configured allowlist is recorded as “other”.</p>`
    : ''
  const notes = (report.notes ?? [])
    .map((n) => `<p>Note: ${escapeHtml(n.note)}</p>`)
    .join('')
  const operatorHtml = report.operator
    ? `<p>Scripted steps: ${escapeHtml(report.operator.status)}${report.operator.error ? ` — ${escapeHtml(report.operator.error)}` : ''}.</p>`
    : ''
  const networkHtml = report.network
    ? `<ul>${report.network.faults.map((record) => `<li>${escapeHtml(networkStepSummary(record))}</li>`).join('')}</ul>${report.network.restoreError ? `<p>Network faults were not removed: ${escapeHtml(report.network.restoreError)}</p>` : ''}`
    : ''
  const fileFaultsHtml = report.fileFaults?.length
    ? `<ul>${report.fileFaults.map((record) => `<li>${escapeHtml(fileFaultSummary(record))}</li>`).join('')}</ul>`
    : ''
  const samplingHtml = sampling
    ? `<p>Configured delay: ${sampling.requestedDelayMs} ms. Completed samples: ${sampling.completedSamples}. Mean sample duration: ${sampling.sampleDuration.meanMs ?? 'unavailable'} ms. Mean start-to-start cadence: ${sampling.startToStart.meanMs ?? 'unavailable'} ms (maximum ${sampling.startToStart.maxMs ?? 'unavailable'} ms).</p><p>${escapeHtml(sampling.note)}</p>`
    : ''
  const phases = phaseRows
    ? `<table><thead><tr><th>Measured phase</th><th>Mean ms</th><th>Maximum ms</th></tr></thead><tbody>${phaseRows}</tbody></table><p>Renderer read time is included in the UI round trip, not additional to it.</p>`
    : ''
  const findings = report.findings
    .map(
      (f) =>
        `<p>Interval ${f.interval}: ${escapeHtml(observationSummary(f))} <strong>${escapeHtml(f.code)}</strong> — ${escapeHtml(f.basis)}</p>`,
    )
    .join('')
  return renderTemplate('observation', {
    status: report.status,
    version: report.metadata?.recoveryProbeVersion ?? 'unknown',
    node: report.metadata?.runtime?.node ?? 'unknown',
    browser: report.metadata?.browserVersion ?? 'unknown',
    ipcHook: report.metadata?.ipcHook?.version ?? 'unknown / not applicable',
    sampling: samplingHtml,
    detail: report.detail ?? 'region (legacy)',
    phases,
    limitation: report.limitation ?? report.error,
    intervals,
    findings,
    operator: operatorHtml + networkHtml + fileFaultsHtml,
    actions: actionsHtml,
    trackedRows,
    notes,
    comparisons,
    cleanup: report.cleanup ?? 'unknown',
    evidence: JSON.stringify(report, null, 2),
  })
}
