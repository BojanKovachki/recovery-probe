import type { IpcPushStats, IpcReadStats } from '../../ipc-probe.cjs'
import type { ObservationConfig } from './config.mjs'
import type { ReadCounts } from './report.mjs'

type ReadRow = IpcReadStats & { methods?: Record<string, IpcReadStats> }

/** Read counters from the HTTP observer or the IPC development hook. */
export interface ReadSnapshot {
  startedAt: number
  capturedAt: number
  channels: Record<string, ReadRow>
  pushes?: Record<
    string,
    IpcPushStats & { methods?: Record<string, IpcPushStats> }
  >
}

const zero: IpcReadStats = {
  calls: 0,
  successes: 0,
  errors: 0,
  pending: 0,
  firstReadAt: null,
  lastReadAt: null,
  firstCompletedAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
}

/** The channel or endpoint the observation reads. */
export const readTarget = (c: ObservationConfig) =>
  (c.transport === 'ipc' ? c.channel : c.endpoint)!

/** The selected read: the whole target, or only the configured methods on a shared channel. */
export function selectedReads(
  snapshot: ReadSnapshot,
  c: ObservationConfig,
): IpcReadStats | undefined {
  const row = snapshot.channels[readTarget(c)]
  if (!c.methods || !row) return row
  const total = { ...zero }
  for (const name of c.methods) {
    const method = row.methods?.[name]
    if (method) addReads(total, method)
  }
  return total
}

/** Adds `m`'s counts to `total`, keeping the earliest first and the latest last times. */
function addReads(total: IpcReadStats, m: IpcReadStats) {
  for (const k of ['calls', 'successes', 'errors', 'pending'] as const)
    total[k] += m[k]
  for (const k of ['lastReadAt', 'lastCompletedAt', 'lastSuccessAt'] as const)
    total[k] = Math.max(total[k] ?? 0, m[k] ?? 0) || null
  for (const k of ['firstReadAt', 'firstCompletedAt'] as const)
    total[k] = m[k] === null ? total[k] : Math.min(total[k] ?? Infinity, m[k])
}

export function dataEvents(
  snapshot: ReadSnapshot,
  c: ObservationConfig,
): { count: number; lastAt: number | null } | null {
  if (!c.dataEvents) return null
  const p = snapshot.pushes?.[c.dataEvents.channel]
  if (!p) return { count: 0, lastAt: null }
  if (!c.dataEvents.methods) return { count: p.count, lastAt: p.lastAt }
  let count = 0,
    lastAt: number | null = null
  for (const name of c.dataEvents.methods) {
    const m = p.methods?.[name]
    if (m) {
      count += m.count
      lastAt = Math.max(lastAt ?? 0, m.lastAt ?? 0) || lastAt
    }
  }
  return { count, lastAt }
}

export const counts = (row: IpcReadStats): ReadCounts => ({
  calls: row.calls,
  successes: row.successes,
  errors: row.errors,
  pending: row.pending,
})

export const delta = (row: IpcReadStats, base: ReadCounts) => ({
  calls: row.calls - base.calls,
  successes: row.successes - base.successes,
  errors: row.errors - base.errors,
  pending: row.pending,
  pendingAtStart: base.pending,
})

export const age = (snapshot: ReadSnapshot, at: number | null) =>
  at === null ? null : Math.max(0, snapshot.capturedAt - at)

export const completedOf = (row: ReadCounts) => row.successes + row.errors
