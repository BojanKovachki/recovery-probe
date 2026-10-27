import type { IpcSnapshot } from '../../../ipc-probe.cjs'
import type { IpcFault } from '../../../transports/ipc/control.mjs'
import type { IpcCheckConfig } from './config.mjs'

export interface IpcPhaseResult {
  outcome: 'pass' | 'fail' | 'inconclusive'
  code: string
  /** Why the healthy baseline failed, with BASELINE_FAILED. */
  reason?: string
  snapshot: IpcSnapshot
}

export type IpcVerdict = Omit<IpcPhaseResult, 'snapshot'>

/** One poll of a phase: no fault for a baseline, and whether its time is up. */
export interface PhaseState {
  fault: IpcFault | undefined
  snapshot: IpcSnapshot
  /** Why the screen doesn't show the read's data yet; undefined once it does. */
  readyProblem: string | undefined
  expired: boolean
}

type Channels = Pick<IpcCheckConfig, 'channel' | 'requiredChannels'>
type ChannelRow = IpcSnapshot['channels'][string]

const inconclusive = (code: string): IpcVerdict => ({
  outcome: 'inconclusive',
  code,
})

const succeeded = (row: ChannelRow) => row.successes > 0 && row.pending === 0

/** The phase's result from the hook's counters, or undefined to keep waiting. */
export function phaseVerdict(
  { channel, requiredChannels }: Channels,
  state: PhaseState,
): IpcVerdict | undefined {
  const { fault, snapshot, readyProblem } = state
  const target = snapshot.channels[channel]
  if (requiredChannels.some((name) => snapshot.channels[name].errors > 0))
    return inconclusive('DEPENDENCY_FAILED')
  // A baseline makes one read; a fault adds the app's retry.
  if (target.calls > (fault ? 2 : 1))
    return inconclusive(fault ? 'TRAFFIC_AMBIGUOUS' : 'BASELINE_AMBIGUOUS')
  const waitingFor = requiredChannels.find(
    (name) => !succeeded(snapshot.channels[name]),
  )
  if (
    readDone(fault, snapshot, target) &&
    !waitingFor &&
    readyProblem === undefined
  )
    return { outcome: 'pass', code: fault ? 'RECOVERED' : 'BASELINE_READY' }
  return state.expired ? timedOut(channel, state, waitingFor) : undefined
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
  channel: string,
  { fault, snapshot, readyProblem }: PhaseState,
  waitingFor: string | undefined,
): IpcVerdict {
  if (!fault)
    return {
      ...inconclusive('BASELINE_FAILED'),
      reason: baselineReason(
        channel,
        snapshot.channels[channel],
        waitingFor,
        readyProblem,
      ),
    }
  if (snapshot.injected !== 1) return inconclusive('FAULT_NOT_TRIGGERED')
  if (waitingFor) return inconclusive('DEPENDENCY_NOT_READY')
  return { outcome: 'fail', code: 'RECOVERY_NOT_OBSERVED' }
}

// The first thing missing, in the order the screen needs them: the read, its dependencies, the data on screen.
function baselineReason(
  channel: string,
  target: ChannelRow,
  waitingFor: string | undefined,
  readyProblem: string | undefined,
) {
  if (!target.calls) return `the app made no ${channel} call`
  if (target.pending) return `the ${channel} call didn't finish`
  if (!target.successes) return `the ${channel} call didn't succeed`
  if (waitingFor) return `the required ${waitingFor} call didn't succeed`
  return readyProblem
}
