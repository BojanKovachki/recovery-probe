import type { RegionSummary } from '../../core/screen.mjs'
import type { WindowReport } from '../../targets/visibility.mjs'
import type { IpcFault } from '../../transports/ipc/control.mjs'
import type { StepResult } from '../observe/steps.mjs'

export type ActionRunKind = 'success' | 'failure' | 'double-click'

export interface ActionRun {
  kind: ActionRunKind
  fault: IpcFault
  /** Requests the action sent; the hook answered all of them. */
  requests: number
  /** Requests that reached the app's own handler because the plan ran out. */
  realRequests: number
  before: RegionSummary
  timeline: { elapsedMs: number; ui: RegionSummary }[]
  final: RegionSummary
  /** Hashes of status or alert messages that appeared after the action, such as toasts. */
  announced: string[]
  uncaughtErrors: number
  devErrorOverlay: boolean
  setup: StepResult[]
}

export interface ActionFinding {
  id: string
  classification: string
  kind: 'suspected-defect' | 'decision-needed' | 'observation' | 'inconclusive'
  advice: string
}

export interface IpcActionReport {
  schemaVersion: 1
  mode: 'IPC action check'
  channel: string
  generatedAt: string
  latencyMs: number
  runs: ActionRun[]
  findings: ActionFinding[]
  finalReset: 'healthy' | 'not-verified'
  ok: boolean
  window?: WindowReport
  error?: string
  cleanupError?: string
  windowRestoreError?: string
  limitation: string
}
