import type { IpcSnapshot } from '../../../ipc-probe.cjs'
import type { IpcFault } from '../../../transports/ipc/control.mjs'
import type { IpcCheckConfig } from './config.mjs'

export interface IpcPhaseResult {
  outcome: 'pass' | 'fail' | 'inconclusive'
  code: string
  snapshot: IpcSnapshot
}

export type IpcVerdict = Omit<IpcPhaseResult, 'snapshot'>

/** One poll of a phase: no fault for a baseline, and whether its time is up. */
export interface PhaseState {
  fault: IpcFault | undefined
  snapshot: IpcSnapshot
  ready: boolean
  expired: boolean
}

type Channels = Pick<IpcCheckConfig, 'channel' | 'requiredChannels'>
type ChannelRow = IpcSnapshot['channels'][string]

const inconclusive = (code: string): IpcVerdict => ({
  outcome: 'inconclusive',
  code,
})

/** The phase's result from the hook's counters, or undefined to keep waiting. */
export function phaseVerdict(
  { channel, requiredChannels }: Channels,
  { fault, snapshot, ready, expired }: PhaseState,
): IpcVerdict | undefined {
  const target = snapshot.channels[channel]
  const dependencies = requiredChannels.map((name) => snapshot.channels[name])
  if (dependencies.some((row) => row.errors > 0))
    return inconclusive('DEPENDENCY_FAILED')
  // A baseline makes one read; a fault adds the app's retry.
  if (target.calls > (fault ? 2 : 1))
    return inconclusive(fault ? 'TRAFFIC_AMBIGUOUS' : 'BASELINE_AMBIGUOUS')
  const dependenciesReady = dependencies.every(
    (row) => row.successes > 0 && row.pending === 0,
  )
  if (readDone(fault, snapshot, target) && dependenciesReady && ready)
    return { outcome: 'pass', code: fault ? 'RECOVERED' : 'BASELINE_READY' }
  return expired ? timedOut(fault, snapshot, dependenciesReady) : undefined
}

const readDone = (
  fault: IpcFault | undefined,
  snapshot: IpcSnapshot,
  target: ChannelRow,
) =>
  !target.pending &&
  (fault
    ? snapshot.injected === 1 && snapshot.successfulAfterFault > 0
    : target.calls === 1 && target.successes === 1)

function timedOut(
  fault: IpcFault | undefined,
  snapshot: IpcSnapshot,
  dependenciesReady: boolean,
): IpcVerdict {
  if (!fault) return inconclusive('BASELINE_FAILED')
  if (snapshot.injected !== 1) return inconclusive('FAULT_NOT_TRIGGERED')
  if (!dependenciesReady) return inconclusive('DEPENDENCY_NOT_READY')
  return { outcome: 'fail', code: 'RECOVERY_NOT_OBSERVED' }
}
