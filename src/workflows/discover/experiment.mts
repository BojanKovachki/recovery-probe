/** The most calls per load that discovery fails one by one. */
export const MAX_TARGETED_CALL = 4

/**
 * Which later calls to fail one by one: when every healthy load read the
 * target the same number of times, the 2nd call up to MAX_TARGETED_CALL.
 */
export function laterCalls(callsPerLoad: number[]): number[] {
  const [calls] = callsPerLoad
  if (!callsPerLoad.every((n) => n === calls)) return []
  return Array.from(
    { length: Math.max(0, Math.min(calls, MAX_TARGETED_CALL) - 1) },
    (_, i) => i + 2,
  )
}

/** Why later calls of a load were not all failed one by one, if they were not. */
export function callsGap(
  callsPerLoad: number[],
  canSkip = true,
): string | undefined {
  const most = Math.max(...callsPerLoad)
  if (most < 2) return undefined
  if (!canSkip)
    return 'The loaded hook cannot let calls through before a fault, so only the first call of a load was failed on its own. Restart the app with the hook from this version.'
  if (!laterCalls(callsPerLoad).length)
    return `Healthy loads read the target a different number of times (${callsPerLoad.join(', ')}), so only the first call was failed on its own.`
  if (most > MAX_TARGETED_CALL)
    return `Calls after the ${MAX_TARGETED_CALL}th of a load were not failed on their own.`
}

export interface DiscoveryExperiment<Fault extends string = string> {
  fault: Fault
  times: number
  /** The call of the load to fail first, when it is not the first. */
  call?: number
}

/** An experiment's id, such as rejection-1 or rejection-1-call2. */
export function findingId(run: DiscoveryExperiment): string {
  return `${run.fault}-${run.times}${run.call ? `-call${run.call}` : ''}`
}

export interface DiscoveryInterpretation {
  classification: string
  kind?: string
  [key: string]: unknown
}

/** An experiment's verdict, or the partial evidence kept when it was interrupted. */
export interface DiscoveryFinding {
  id: string
  fault: string
  times: number
  /** The call of the load that failed, when it was not the first. */
  call?: number
  classification: string
  kind: string
  confidence?: string
  confirmations: number
  repeatConfirmed: boolean
  advice: string
  observationMs?: number
  verification?: string
  partial?: true
  completedRuns?: number
  plannedRuns?: number
  observedInterpretation?: DiscoveryInterpretation
  stoppedReason?: string
}

interface DiscoveryRun {
  fault: string
  times: number
  call?: number
  interpretation?: DiscoveryInterpretation
  assessment?: DiscoveryInterpretation
}

// A stable intermediate screen is not a healthy control once a baseline exists.
export function matchesHealthyControl(
  ui: { fingerprint?: string },
  expectedFingerprint: string | undefined,
): boolean {
  return (
    expectedFingerprint === undefined || ui.fingerprint === expectedFingerprint
  )
}

// Keep completed runs visible when a later control aborts an experiment.
// Partial evidence must not inherit a confirmed defect/healthy verdict.
export function retainPartialFindings(
  report: {
    results: DiscoveryRun[]
    findings: DiscoveryFinding[]
    error?: string
  },
  plannedRuns: number,
): void {
  const groups = new Map<string, DiscoveryRun[]>()
  for (const run of report.results) {
    const id = findingId(run)
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(run)
  }
  for (const [id, runs] of groups) {
    if (report.findings.some((finding) => finding.id === id)) continue
    const interpretations = runs.map(
      (run) => (run.interpretation ?? run.assessment)!,
    )
    const consistent = interpretations.every(
      (value) => value.classification === interpretations[0].classification,
    )
    report.findings.push({
      id,
      fault: runs[0].fault,
      times: runs[0].times,
      ...(runs[0].call ? { call: runs[0].call } : {}),
      classification: 'INCOMPLETE_EXPERIMENT',
      kind: 'inconclusive',
      confidence: 'low',
      confirmations: runs.length,
      completedRuns: runs.length,
      plannedRuns,
      partial: true,
      repeatConfirmed: false,
      observedInterpretation: consistent
        ? interpretations[0]
        : { classification: 'UNSTABLE', kind: 'inconclusive' },
      stoppedReason: report.error ?? 'Experiment interrupted',
      advice:
        'Completed runs are partial evidence. Resolve the stopped control before claiming repeat confirmation.',
    })
  }
}
