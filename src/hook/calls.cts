import { setTimeout as sleep } from 'node:timers/promises'
import type { IpcFault } from './checks.cjs'
import type { IpcReadStats, ProbeState } from './types.cjs'

type ChannelRow = ProbeState['channels'][string]

/** What a faulted call returns: null or a rejection, after the plan's delay. */
export function injectedResult(fault: IpcFault, delayMs: number) {
  const settle = () =>
    fault === 'null-result'
      ? Promise.resolve(null)
      : Promise.reject(new Error('Recovery Probe: injected IPC rejection'))
  return delayMs ? sleep(delayMs).then(settle) : settle()
}

/**
 * Runs a real call and counts how it settles, in its channel's row and its method's,
 * without replacing the handler's own return value or Promise.
 */
export function trackCall(
  current: ProbeState,
  channel: string,
  { row, method }: { row: ChannelRow; method: IpcReadStats | null },
  invoke: () => unknown,
): unknown {
  row.realCalls++
  row.pending++
  if (method) method.pending++
  const started = Date.now()
  const afterFault = current.injected > 0
  const finish = (success: boolean) => {
    settle(method ? [row, method] : [row], success)
    row.maxDurationMs = Math.max(row.maxDurationMs, Date.now() - started)
    if (success && afterFault && channel === current.channel)
      current.successfulAfterFault++
  }
  let result: unknown
  try {
    result = invoke()
  } catch (error) {
    finish(false)
    throw error
  }
  Promise.resolve(result).then(
    () => finish(true),
    () => finish(false),
  )
  return result
}

function settle(rows: IpcReadStats[], success: boolean) {
  const completed = Date.now()
  for (const stats of rows) {
    stats.firstCompletedAt ??= completed
    stats.lastCompletedAt = completed
    if (success) {
      stats.lastSuccessAt = completed
      stats.successes++
    } else stats.errors++
    stats.pending--
  }
}
