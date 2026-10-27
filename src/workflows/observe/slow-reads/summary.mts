import type { SlowRead, SlowReadBasis } from './evidence.mjs'

/** 850 → "0.9 s", 242000 → "4 min 2 s". */
export function duration(ms: number): string {
  if (ms < 59950) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)} min ${s % 60} s`
}

/** 4000, 4050 → "4.0–4.1 s"; the unit is written once when both bounds share it. */
function between(low: number, high: number) {
  const from = duration(Math.max(0, low)),
    to = duration(high)
  if (from === to) return `about ${to}`
  return from.includes('min') || to.includes('min')
    ? `${from}–${to}`
    : `${from.slice(0, -2)}–${to}`
}

const http = (read: SlowRead) =>
  read.status === null ? '' : ` (HTTP ${read.status})`

function response(read: SlowRead) {
  const ms = read.networkMs ?? read.completedMs! - read.startedMs
  return `The response took ${duration(ms)}${http(read)}`
}

function shown(read: SlowRead) {
  const [from, to] = read.contentShownMs!
  return `content appeared ${between(from - read.startedMs, to - read.startedMs)} after the read started`
}

function waiting(read: SlowRead) {
  const parts = [
    read.slowestScreenReadMs !== null && read.slowestScreenReadMs >= 1000
      ? `one screen read took ${duration(read.slowestScreenReadMs)}`
      : '',
    read.maxBridgePending
      ? `up to ${read.maxBridgePending} bridge requests were waiting`
      : '',
  ].filter(Boolean)
  return parts.length ? `; ${parts.join(', and ')}` : ''
}

function busy(read: SlowRead) {
  return read.rendererBusyPercent === null
    ? 'renderer load was not measured'
    : `the renderer’s main thread was busy ${read.rendererBusyPercent}% of that time`
}

const BY_BASIS: Record<
  SlowReadBasis,
  (read: SlowRead, endMs: number) => string
> = {
  NETWORK: (read) =>
    read.outcome !== 'success'
      ? `The read ${read.outcome === 'failed' ? 'failed' : 'returned an error'} after ${duration(read.completedMs! - read.startedMs)}${http(read)}.`
      : read.contentShownMs
        ? `${response(read)}; ${shown(read)}.`
        : `${response(read)}.`,
  RENDERER_BUSY: (read) =>
    `${response(read)}, but ${shown(read)}: ${busy(read)}${waiting(read)}.`,
  AFTER_RESPONSE: (read) =>
    `${response(read)}, but ${shown(read)}, and ${busy(read)}${waiting(read)}. The screen waited on something other than this read and the main thread.`,
  NO_CONTENT: (read, endMs) =>
    `${response(read)}, but the content marker did not appear in the ${duration(endMs - read.completedMs!)} that followed; ${busy(read)}${waiting(read)}.`,
  STILL_PENDING: (read, endMs) =>
    `The read started ${duration(endMs - read.startedMs)} before the capture ended and had not finished; ${busy(read)}${waiting(read)}.`,
}

export function slowReadSummary(
  read: SlowRead,
  {
    basis,
    earlierFailures,
    endMs,
  }: { basis: SlowReadBasis; earlierFailures: number; endMs: number },
): string {
  const late =
    read.sinceIntervalStartMs >= 1000
      ? `It started ${duration(read.sinceIntervalStartMs)} into the interval. `
      : ''
  const failures = earlierFailures
    ? `${earlierFailures} earlier ${earlierFailures === 1 ? 'read' : 'reads'} in this interval failed. `
    : ''
  return `${failures}${late}${BY_BASIS[basis](read, endMs)}`
}
