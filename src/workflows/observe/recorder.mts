import type { RegionRead } from '../../core/region-read.mjs'
import type { summarizeRegion } from '../../core/screen.mjs'
import type { ObservationConfig } from './config.mjs'
import { initialReport, type CaptureReport } from './initial-report.mjs'
import {
  age,
  completedOf,
  counts,
  dataEvents,
  delta,
  readTarget,
  selectedReads,
  type ReadSnapshot,
} from './reads.mjs'
import { actionEffects } from './action-effects.mjs'
import { ContentComparisons } from './comparisons.mjs'
import { samplingMetrics, type SamplingTimings } from './sampling.mjs'
import {
  type ObservationInterval,
  type ObservedAction,
  type SummarizedRows,
  type TimelineEvent,
} from './report.mjs'
import { RowTracker } from './rows.mjs'
import { contentBeforeRead, firstContent, showsContent } from './sample.mjs'
import type { ReadLogSnapshot } from '../../transports/http/read-log.mjs'
import { SlowReadTracker } from './slow-reads/evidence.mjs'
import type { LoadSample, ProbeStatus } from './slow-reads/probe.mjs'

/** A screen read between two read snapshots, so each read lands in one sample. */
export interface Sample {
  before: ReadSnapshot
  after: ReadSnapshot
  fromMs: number
  ui: ReturnType<typeof summarizeRegion>
  rows: SummarizedRows | null
  actions: RegionRead['actions']
  phases: SamplingTimings
  /** Renderer and bridge load, when `slowReads` is configured. */
  load?: LoadSample | null
}

/** What slow-read evidence needs from the end of the capture. */
export interface SlowReadsEnd {
  readLog: ReadLogSnapshot | undefined
  probe: ProbeStatus
  startedEpoch: number
}

/** Capture time: milliseconds since the capture started, and when that was. */
export interface Clock {
  elapsed: () => number
  startedEpoch: number
}

const MAX_ACTIONS = 200
const MAX_RECORDED = 1000

type SelectedReads = NonNullable<ReturnType<typeof selectedReads>>

/** Turns samples into the observation report: intervals, findings, timeline and comparisons. */
export class ObservationRecorder {
  readonly report: CaptureReport
  readonly #config: ObservationConfig
  readonly #metrics: ReturnType<typeof samplingMetrics>
  readonly #comparisons = new ContentComparisons()
  readonly #tracker: RowTracker | null
  readonly #slowReads: SlowReadTracker | null
  #interval?: ObservationInterval
  #previousSignature?: string
  #samples = 0

  constructor(config: ObservationConfig) {
    this.#config = config
    this.report = initialReport(config)
    this.#metrics = samplingMetrics(config.sampleMs)
    this.#tracker = config.rows ? new RowTracker(config) : null
    this.#slowReads = config.slowReads
      ? new SlowReadTracker(config.slowReads)
      : null
  }

  get intervalOpen() {
    return this.#interval !== undefined
  }

  get samples() {
    return this.#samples
  }

  gap(code: string) {
    const gaps = this.report.coverage.gaps
    if (!gaps.includes(code)) gaps.push(code)
  }

  openInterval(s: ReadSnapshot, startMs: number): ObservationInterval {
    const c = this.#config
    const interval: ObservationInterval = {
      index: this.report.intervals.length + 1,
      startMs,
      startCounts: counts(selectedReads(s, c)!),
      firstContent: null,
      samples: 0,
      findings: [],
      ...(c.methods
        ? { startChannelCounts: counts(s.channels[readTarget(c)]) }
        : {}),
      ...(c.dataEvents ? { startDataEvents: dataEvents(s, c)!.count } : {}),
    }
    this.#interval = interval
    this.report.intervals.push(interval)
    this.#previousSignature = undefined
    return interval
  }

  closeInterval(s: ReadSnapshot | undefined, endMs: number) {
    const interval = this.#interval
    if (!interval || !s) return
    const c = this.#config
    interval.endMs = endMs
    interval.reads = delta(selectedReads(s, c)!, interval.startCounts!)
    if (c.methods)
      interval.channelReads = delta(
        s.channels[readTarget(c)],
        interval.startChannelCounts!,
      )
    if (c.dataEvents)
      interval.dataEvents = dataEvents(s, c)!.count - interval.startDataEvents!
    delete interval.startChannelCounts
    delete interval.startDataEvents
  }

  /** Records one sample and returns its timeline event. */
  addSample(sample: Sample, clock: Clock, pageErrors: number): TimelineEvent {
    const row = selectedReads(sample.after, this.#config)
    if (!row || !Object.hasOwn(row, 'lastCompletedAt'))
      throw Error('READ_TIMESTAMPS_UNAVAILABLE')
    if (!sample.ui.visible) this.gap('HIDDEN_DOCUMENT')
    if (sample.ui.truncated) this.gap('TRUNCATED_REGION')
    if (sample.rows?.truncated) this.gap('TRUNCATED_ROWS')
    const data = dataEvents(sample.after, this.#config)
    const event = this.#event(sample, row, data, { clock, pageErrors })
    this.#addActions(sample.actions, clock)
    this.#tracker?.add({
      index: this.#samples,
      interval: event.interval,
      fromMs: sample.fromMs,
      toMs: event.toMs,
      rows: sample.rows,
      completed: completedOf(row),
      data: data && {
        count: data.count,
        lastAtMs:
          data.lastAt === null ? null : data.lastAt - clock.startedEpoch,
      },
    })
    this.#addContent(event)
    this.#addEvent(event, sample.rows, pageErrors)
    this.#addLoad(event, sample)
    this.#metrics.add(event.fromMs, event.toMs, sample.phases)
    this.#interval!.samples++
    this.#samples++
    return event
  }

  #addLoad(event: TimelineEvent, sample: Sample) {
    this.#slowReads?.add({
      interval: event.interval,
      fromMs: event.fromMs,
      toMs: event.toMs,
      content: showsContent(event),
      screenReadMs: sample.phases.uiRoundTripMs ?? 0,
      load: sample.load ?? null,
    })
  }

  /** Records how long sampling ran and the last read snapshot, before any cleanup. */
  endSampling(elapsedMs: number, lastSnapshot: ReadSnapshot | undefined) {
    const report = this.report
    report.elapsedMs = elapsedMs
    report.samples = this.#samples
    report.sampling = this.#metrics.snapshot()
    report.snapshot = lastSnapshot
    report.snapshotStage = 'before-cleanup'
  }

  /** Adds what can only be judged over the whole capture, and whether it is complete. */
  conclude(slowReads?: SlowReadsEnd) {
    const report = this.report
    // A capture that failed before its first interval has no reads to place.
    if (this.#slowReads && slowReads && report.intervals.length)
      this.#concludeSlowReads(slowReads)
    if (this.#tracker) {
      const tracked = this.#tracker.snapshot()
      report.rows = tracked.rows
      report.findings.push(...tracked.findings)
    }
    if (report.actions) report.actionEffects = actionEffects(report)
    this.#omitUnattributableComparisons()
    if (this.#samples > 0 && !report.intervals.some((i) => i.firstContent))
      this.gap('CONTENT_MARKER_NOT_OBSERVED')
    report.captureComplete =
      report.status === 'complete' && report.coverage.gaps.length === 0
  }

  #concludeSlowReads(end: SlowReadsEnd) {
    const report = this.report
    const { section, findings } = this.#slowReads!.conclude({
      ...end,
      intervals: report.intervals,
      endMs: report.elapsedMs ?? 0,
    })
    report.slowReads = section
    report.findings.push(...findings)
    if (!section.renderer.measured) this.gap('RENDERER_LOAD_UNAVAILABLE')
    if (section.bridge && !section.bridge.installed)
      this.gap('BRIDGE_NOT_INSTRUMENTED')
    if (section.readLogTruncated) this.gap('READ_LOG_LIMIT_REACHED')
    if (section.samplesTruncated) this.gap('SLOW_READ_SAMPLE_LIMIT_REACHED')
  }

  #event(
    sample: Sample,
    row: SelectedReads,
    data: ReturnType<typeof dataEvents>,
    { clock, pageErrors }: { clock: Clock; pageErrors: number },
  ): TimelineEvent {
    const interval = this.#interval!
    const after = sample.after
    return {
      interval: interval.index,
      fromMs: sample.fromMs,
      toMs: clock.elapsed(),
      ui: sample.ui,
      ...(sample.rows ? { rows: sample.rows } : {}),
      reads: delta(row, interval.startCounts!),
      before: counts(selectedReads(sample.before, this.#config)!),
      after: counts(row),
      lastReadAgeMs: age(after, row.lastReadAt),
      lastCompletionAgeMs: age(after, row.lastCompletedAt),
      ...(data
        ? {
            dataEvents: data.count - interval.startDataEvents!,
            lastDataEventAgeMs: age(after, data.lastAt),
          }
        : {}),
      pageErrors,
    }
  }

  #addActions(raw: Sample['actions'], clock: Clock) {
    const actions = this.report.actions
    if (!raw?.length || !actions) return
    const intervals = this.report.intervals
    for (const a of raw) {
      const atMs = a.at - clock.startedEpoch
      const owner =
        [...intervals].reverse().find((i) => i.startMs <= atMs) ?? intervals[0]
      const action: ObservedAction = {
        name: a.name,
        atMs,
        trusted: a.trusted,
        interval: owner.index,
      }
      if (actions.length < MAX_ACTIONS) actions.push(action)
      else this.gap('ACTION_LIMIT_REACHED')
    }
    this.#tracker?.addActions(actions.slice(-raw.length))
  }

  #addContent(event: TimelineEvent) {
    const interval = this.#interval!
    if (!interval.firstContent)
      interval.firstContent = firstContent(event, interval)
    if (interval.findings.includes('CONTENT_BEFORE_READ')) return
    const finding = contentBeforeRead(event)
    if (!finding) return
    interval.findings.push(finding.code)
    this.report.findings.push(finding)
  }

  /** Adds `event` to the change-only timeline and the content comparisons. */
  #addEvent(
    event: TimelineEvent,
    rows: SummarizedRows | null,
    pageErrors: number,
  ) {
    const report = this.report
    const signature = JSON.stringify([
      event.interval,
      event.ui,
      rows,
      event.reads,
      event.dataEvents,
      pageErrors,
    ])
    if (signature !== this.#previousSignature) {
      if (report.timeline.length < MAX_RECORDED) report.timeline.push(event)
      else this.gap('TIMELINE_LIMIT_REACHED')
      this.#previousSignature = signature
    }
    for (const comparison of this.#comparisons.add(event)) {
      if (report.comparisons.length < MAX_RECORDED)
        report.comparisons.push(comparison)
      else this.gap('COMPARISON_LIMIT_REACHED')
    }
  }

  // Read-completion comparisons are not meaningful when many selected reads finish during every sample.
  #omitUnattributableComparisons() {
    const report = this.report
    const samples = this.#samples
    const completions = report.intervals.reduce(
      (sum, i) => sum + (i.reads ? completedOf(i.reads) : 0),
      0,
    )
    if (samples === 0 || completions / samples <= 2) return
    const omitted = report.comparisons.filter(
      (cmp) => cmp.basis === 'READ_COMPLETION',
    ).length
    report.comparisons = report.comparisons.filter(
      (cmp) => cmp.basis !== 'READ_COMPLETION',
    )
    report.notes.push({
      code: 'READ_COMPLETION_COMPARISONS_OMITTED',
      completionsPerSample: Math.round((completions / samples) * 100) / 100,
      omitted,
      note: 'The selected target completed more than two reads per sample on average, so per-completion comparisons cannot attribute UI changes. Select specific methods to narrow the target.',
    })
  }
}
