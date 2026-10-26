import type { Page } from 'playwright'
import type {
  classifyObservation,
  compareRegions,
  RegionSummary,
} from '../../core/screen.mjs'
import type {
  WindowReport,
  WindowVisibility,
} from '../../targets/visibility.mjs'
import type { IpcInspector } from '../../transports/ipc/inspector.mjs'
import type { DiscoveryExperiment, DiscoveryFinding } from './experiment.mjs'

export interface ReadStats {
  realCalls: number
  successes: number
  errors: number
  pending: number
}

/** Call counters of one load, in the shape both transports report. */
export interface ReadSnapshot {
  injected: number
  injectedAt: number | null
  successfulAfterFault: number
  injectionError?: boolean
  channels: Record<string, ReadStats>
}

/** Arms a plan for the next load and reports its calls; see transports/session.mts. */
export interface ReadSession<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  begin(plan: { fault?: Fault; times?: number; skip?: number }): Promise<void>
  snapshot(): Snapshot | Promise<Snapshot>
  stop(): Promise<unknown>
}

export interface DiscoverySetup<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  page: Page
  session: ReadSession<Fault, Snapshot>
  /** The selected read and the others the screen needs, as named in snapshots. */
  read: string
  dependencies: string[]
  /** What this transport calls a read in reports. */
  readKind: 'channel' | 'endpoint'
  /** The error when a real read of the target fails. */
  readFailed: string
  experiments: DiscoveryExperiment<Fault>[]
  /** The fault for the later-call experiments; none when the transport can't let calls through. */
  laterCallFault?: Fault
  /** Gives the IPC hook's view of the window when the app has one. */
  control?: IpcInspector
  /** How to rerun the same experiments after a fix. */
  verification: string
}

export interface DiscoveryTiming {
  baselineTimeoutMs: number
  /** How long a faulted load is watched after the first fault. */
  observationMs: number
  settleMs: number
  repeats: number
  regionSelector?: string
  restoreWindow: boolean
}

export interface DiscoveryEvent<Snapshot extends ReadSnapshot> {
  elapsedMs: number
  injected: number
  channels: Snapshot['channels']
  ui: RegionSummary
  uncaughtErrors: number
}

export interface DiscoveryPhase<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  elapsedMs: number
  fault: Fault | 'healthy'
  times: number
  /** The call of the load that failed, when it was not the first. */
  call?: number
  screenshot?: string
  evidenceCaptureFailed?: true
  ready: boolean
  ui: RegionSummary
  snapshot: Snapshot
  timeline: DiscoveryEvent<Snapshot>[]
  newErrors: number
  recoveryDetectedAt: number | null
  recoveryMs: number | null
  timingNote: string
  repeatedReads: ({
    code: 'REPEATED_READS'
    count: number
    redundant: 'not-established'
  } & Partial<Record<'channel' | 'endpoint', string>>)[]
}

export type Assessment = ReturnType<typeof classifyObservation>

export interface DiscoveryRun<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> extends DiscoveryPhase<Fault, Snapshot> {
  control: { ui: RegionSummary; snapshot: Snapshot }
  /** The same as interpretation; kept for reports that read it. */
  assessment: Assessment
  observation: ReturnType<typeof compareRegions> & {
    injected: number
    channels: Snapshot['channels']
    recoveryMs: number | null
    repeatedReads: DiscoveryPhase<Fault, Snapshot>['repeatedReads']
  }
  interpretation: Assessment
}

/** The fields discovery fills in; each transport adds its own around them. */
export interface DiscoveryResult<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> {
  baselines: DiscoveryPhase<Fault, Snapshot>[]
  results: DiscoveryRun<Fault, Snapshot>[]
  findings: DiscoveryFinding[]
  finalReset: 'healthy' | 'not-verified'
  ok: boolean
  readiness: {
    calibrationComplete: boolean
    /** How often each healthy calibration load read the target. */
    callsPerLoad?: number[]
    callsGap?: string
  }
  window?: WindowReport
  environment?: WindowVisibility & { online: boolean; ui: RegionSummary }
  stoppedObservation?: {
    reason: string
    fault: Fault | 'healthy'
    times: number
    snapshot: Snapshot | undefined
    ui: RegionSummary | undefined
    timeline: DiscoveryEvent<Snapshot>[]
  }
  failedControl?: DiscoveryPhase<Fault, Snapshot> & {
    reasons: {
      notReady: boolean
      newErrors: number
      fingerprintChanged: boolean
    }
    diff: ReturnType<typeof compareRegions>
  }
  cleanup?: DiscoveryPhase<Fault, Snapshot>
  error?: string
  cleanupError?: string
  windowRestoreError?: string
}
