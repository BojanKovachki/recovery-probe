import type { ObservationConfig } from './config.mjs'
import { readTarget } from './reads.mjs'
import { observationMetadata, type ObservationReport } from './report.mjs'

/** An observation report with the fields a capture always fills in. */
export type CaptureReport = ObservationReport &
  Required<
    Pick<
      ObservationReport,
      'metadata' | 'comparisons' | 'timeline' | 'notes' | 'coverage'
    >
  >

/** The report before the first sample: incomplete until the capture says otherwise. */
export function initialReport(c: ObservationConfig): CaptureReport {
  return {
    schemaVersion: 1,
    metadata: observationMetadata(),
    mode: 'fault-free observation',
    transport: c.transport,
    target: readTarget(c),
    ...(c.methods ? { targetMethods: c.methods } : {}),
    generatedAt: new Date().toISOString(),
    status: 'incomplete',
    captureComplete: false,
    observationMs: c.observationMs,
    sampleMs: c.sampleMs,
    detail: c.detail,
    intervals: [],
    findings: [],
    comparisons: [],
    timeline: [],
    ...(c.actions ? { actions: [] } : {}),
    notes: [],
    injected: 0,
    reloads: 0,
    cleanup: 'not-started',
    coverage: {
      historyBeforeCapture: 'unknown',
      pendingBeforeCapture: 'unknown',
      scope:
        'One selected renderer and read target; only calls starting during capture are counted.',
      gaps: [],
    },
    limitation:
      'Observations are not recovery passes or account-isolation verdicts. Cache reuse may be legitimate. Intervals start at capture or an operator marker, not at a proven mount or identity change. HTTP success means a completed 2xx response, not valid JSON or UI correctness. UI changes between samples can be missed. Only hashes, structural counts, allowlisted row states, configured action names and read metadata are stored; hashes are not anonymization.',
  }
}
