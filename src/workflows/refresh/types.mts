import type { compareRegions, RegionSummary } from '../../core/screen.mjs'
import type { RefreshFault, RefreshTrigger } from './config.mjs'

export interface ReadRow {
  calls: number
  realCalls: number
  successes: number
  errors: number
  pending: number
}

/** What both transports report: per-read counts and the fault's progress. */
export interface RefreshSnapshot {
  channels: Record<string, ReadRow>
  injected: number
  successfulAfterFault: number
  injectionError?: boolean
}

/** An HTTP or IPC observer that the experiment arms, reads and stops. */
export interface RefreshAdapter {
  begin(fault?: {
    fault?: RefreshFault
    times?: number
    ttlMs?: number
  }): Promise<unknown>
  snapshot(): RefreshSnapshot | Promise<RefreshSnapshot>
  disarm(): Promise<unknown>
  stop(): Promise<unknown>
}

export interface Sample {
  ui: RegionSummary
  snapshot: RefreshSnapshot
}

export interface Observed extends Sample {
  elapsedMs: number
  timeline: (Sample & { elapsedMs: number })[]
  ready: boolean
}

export interface Emitted {
  firedAt: number
  event: string
  synthesized: true
  online: boolean
  visibility: DocumentVisibilityState
}

export type RefreshKind =
  'observation' | 'suspected-defect' | 'decision-needed' | 'inconclusive'

export interface RefreshRun {
  run: number
  requested: number
  observationMs: number
  attribution: { kind: 'temporal-association'; causalProof: false }
  stage: 'control' | 'fault' | 'second-trigger' | 'completed'
  healthy?: Observed
  idle?: Observed
  controlTrigger?: Emitted
  control?: Observed
  controlReads?: { read: string; calls: number }[]
  preFault?: Observed
  preFaultIdle?: Observed
  trigger?: Emitted
  spontaneous?: Observed
  injected?: number
  observation?: ReturnType<typeof compareRegions>
  subsequentRealReads?: number
  noSubsequentReadObserved?: boolean
  code?: string
  kind?: RefreshKind
  freshReadSucceeded?: boolean
  secondTrigger?: Emitted
  afterSecondTrigger?: Observed
  secondTriggerResult?:
    | 'RECOVERED_AFTER_TRIGGER'
    | 'NO_REFRESH_SUCCESS_OBSERVED'
    | 'NOT_RECOVERED_WITHIN_WINDOW'
  summary?: string
}

export interface RefreshFinding {
  id: string
  classification: string
  kind: RefreshKind
  completedRuns: number
  plannedRuns: number
  repeatConsistent: boolean
  repeatConfirmed: boolean
}

export interface RefreshReport {
  schemaVersion: 1
  mode: 'refresh experiment'
  trigger: RefreshTrigger & {
    synthesized: true
    changesNetworkState: false
  }
  readiness: {
    strategy: 'bounded-end-state-calibration'
    calibrationRuns: number
    calibrationWindowMs: number
    settleMs: number
    limitation: string
  }
  baselines: Observed[]
  results: RefreshRun[]
  findings: RefreshFinding[]
  ok: boolean
  finalReset: 'healthy' | 'not-verified'
  faultReset: 'healthy' | 'not-verified'
  limitation: string
  stoppedObservation?: Observed
  cleanup?: Observed
  error?: string
  cleanupError?: string
}
