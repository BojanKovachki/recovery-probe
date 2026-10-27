import type {
  ReadLogSnapshot,
  ReadRecord,
} from '../../../transports/http/read-log.mjs'
import type { ObservationFinding } from '../report.mjs'
import type { SlowReadsConfig } from './config.mjs'
import type { LoadSample, ProbeStatus } from './probe.mjs'
import { slowReadSummary } from './summary.mjs'

/** One sample, as far as slow-read evidence needs it. Times are capture ms. */
export interface LoadPoint {
  interval: number
  fromMs: number
  toMs: number
  content: boolean
  /** How long the renderer took to answer the screen read. */
  screenReadMs: number
  load: LoadSample | null
}

export interface SlowRead {
  interval: number
  startedMs: number
  sinceIntervalStartMs: number
  completedMs: number | null
  outcome: ReadRecord['outcome']
  status: number | null
  networkMs: number | null
  /** Content was already showing when the read started, so it says nothing about this read. */
  contentAlreadyShown: boolean
  /** Bounds of the first sample after the read finished that showed content. */
  contentShownMs: [number, number] | null
  rendererBusyPercent: number | null
  slowestScreenReadMs: number | null
  maxBridgePending: number | null
  slow: boolean
}

export type SlowReadBasis =
  | 'NETWORK'
  | 'RENDERER_BUSY'
  | 'AFTER_RESPONSE'
  | 'NO_CONTENT'
  | 'STILL_PENDING'

export interface SlowReadFinding extends ObservationFinding {
  code: 'SLOW_READ'
  kind: 'observation'
  basis: SlowReadBasis
  /** Index of the read in `slowReads.reads`. */
  read: number
  summary: string
}

export interface SlowReadsSection {
  thresholdMs: number
  renderer: ProbeStatus['renderer']
  bridge:
    | (NonNullable<ProbeStatus['bridge']> & {
        sent: number
        answered: number
        pendingAtEnd: number
      })
    | null
  readLogTruncated: boolean
  samplesTruncated: boolean
  reads: SlowRead[]
}

export interface IntervalBounds {
  index: number
  startMs: number
}

interface Context {
  points: LoadPoint[]
  intervals: IntervalBounds[]
  startedEpoch: number
  endMs: number
  thresholdMs: number
}

const MAX_POINTS = 20000
const MAX_FINDINGS = 20

/** Collects samples during the capture and explains each read of the endpoint at the end. */
export class SlowReadTracker {
  readonly #config: SlowReadsConfig
  readonly #points: LoadPoint[] = []
  #truncated = false

  constructor(config: SlowReadsConfig) {
    this.#config = config
  }

  add(point: LoadPoint) {
    if (this.#points.length < MAX_POINTS) this.#points.push(point)
    else this.#truncated = true
  }

  conclude({
    readLog,
    intervals,
    startedEpoch,
    endMs,
    probe,
  }: {
    readLog: ReadLogSnapshot | undefined
    intervals: IntervalBounds[]
    startedEpoch: number
    endMs: number
    probe: ProbeStatus
  }): { section: SlowReadsSection; findings: SlowReadFinding[] } {
    const context: Context = {
      points: this.#points,
      intervals,
      startedEpoch,
      endMs,
      thresholdMs: this.#config.thresholdMs,
    }
    const reads = (readLog?.reads ?? []).map((r) => slowRead(r, context))
    const section: SlowReadsSection = {
      thresholdMs: this.#config.thresholdMs,
      renderer: probe.renderer,
      bridge: probe.bridge && {
        ...probe.bridge,
        ...bridgeTotals(this.#points),
      },
      readLogTruncated: readLog?.truncated ?? false,
      samplesTruncated: this.#truncated,
      reads,
    }
    return { section, findings: slowReadFindings(reads, endMs) }
  }
}

function slowRead(record: ReadRecord, c: Context): SlowRead {
  const startedMs = record.startedAt - c.startedEpoch
  const completedMs =
    record.completedAt === null ? null : record.completedAt - c.startedEpoch
  const interval =
    [...c.intervals].reverse().find((i) => i.startMs <= startedMs) ??
    c.intervals[0]
  const points = c.points.filter((p) => p.interval === interval.index)
  const before = points.filter((p) => p.toMs <= startedMs).at(-1)
  const contentAlreadyShown = Boolean(before?.content)
  const shown =
    record.outcome === 'success' && completedMs !== null && !contentAlreadyShown
      ? points.find((p) => p.fromMs >= completedMs && p.content)
      : undefined
  const endMs = shown?.toMs ?? completedMs ?? c.endMs
  const span = points.filter((p) => p.toMs >= startedMs && p.fromMs <= endMs)
  const read: SlowRead = {
    interval: interval.index,
    startedMs,
    sinceIntervalStartMs: Math.max(0, startedMs - interval.startMs),
    completedMs,
    outcome: record.outcome,
    status: record.status,
    networkMs: record.networkMs,
    contentAlreadyShown,
    contentShownMs: shown ? [shown.fromMs, shown.toMs] : null,
    rendererBusyPercent: busyPercent(points, startedMs, endMs),
    slowestScreenReadMs: maxOf(span.map((p) => p.screenReadMs)),
    maxBridgePending: maxOf(
      span.flatMap((p) => (p.load?.bridge ? [p.load.bridge.maxPending] : [])),
    ),
    slow: false,
  }
  read.slow = waitedMs(read, c.endMs) >= c.thresholdMs
  return read
}

/** How long the read kept the screen waiting, as far as the capture saw. */
export function waitedMs(read: SlowRead, endMs: number): number {
  if (read.contentShownMs) return read.contentShownMs[1] - read.startedMs
  if (read.completedMs === null) return endMs - read.startedMs
  // A successful read whose content never appeared kept the screen waiting until the end.
  if (read.outcome === 'success' && !read.contentAlreadyShown)
    return endMs - read.startedMs
  return read.completedMs - read.startedMs
}

/** Share of `[fromMs, toMs]` the renderer's main thread spent running tasks. */
function busyPercent(points: LoadPoint[], fromMs: number, toMs: number) {
  const measured = points.filter((p) => p.load?.renderer)
  const first = measured.filter((p) => p.toMs <= fromMs).at(-1) ?? measured[0]
  const last = measured.find((p) => p.toMs >= toMs) ?? measured.at(-1)
  if (!first || !last || last.toMs <= first.toMs) return null
  const busy = last.load!.renderer!.taskMs - first.load!.renderer!.taskMs
  const percent = Math.round((busy / (last.toMs - first.toMs)) * 100)
  return Math.min(100, Math.max(0, percent))
}

const maxOf = (values: number[]) =>
  values.length ? Math.round(Math.max(...values)) : null

function bridgeTotals(points: LoadPoint[]) {
  const last = points.findLast((p) => p.load?.bridge)?.load?.bridge
  return {
    sent: last?.sent ?? 0,
    answered: last?.answered ?? 0,
    pendingAtEnd: last?.pending ?? 0,
  }
}

export function slowReadBasis(read: SlowRead, endMs: number): SlowReadBasis {
  if (read.completedMs === null) return 'STILL_PENDING'
  if (read.outcome !== 'success' || read.contentAlreadyShown) return 'NETWORK'
  if (!read.contentShownMs) return 'NO_CONTENT'
  const network = read.networkMs ?? read.completedMs - read.startedMs
  if (network >= waitedMs(read, endMs) / 2) return 'NETWORK'
  return (read.rendererBusyPercent ?? 0) >= 50
    ? 'RENDERER_BUSY'
    : 'AFTER_RESPONSE'
}

function slowReadFindings(reads: SlowRead[], endMs: number): SlowReadFinding[] {
  const findings: SlowReadFinding[] = []
  reads.forEach((read, index) => {
    if (!read.slow || findings.length >= MAX_FINDINGS) return
    const earlier = reads
      .slice(0, index)
      .filter(
        (r) =>
          r.interval === read.interval &&
          ['error', 'failed'].includes(r.outcome),
      ).length
    const basis = slowReadBasis(read, endMs)
    findings.push({
      code: 'SLOW_READ',
      kind: 'observation',
      basis,
      interval: read.interval,
      read: index,
      summary: slowReadSummary(read, {
        basis,
        earlierFailures: earlier,
        endMs,
      }),
      note: 'Timings come from samples and the browser’s network timing; they bound when content appeared, they do not prove what delayed it.',
    })
  })
  return findings
}
