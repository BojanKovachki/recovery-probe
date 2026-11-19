/** The most calls per load that discovery fails one by one. */
export const MAX_TARGETED_CALL = 4

/** Faults armed to fail every read of one load: the most the IPC hook allows. */
export const EVERY_READ = 10

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
  /** Every read of the load fails, up to `times`, so the app's retries run out. */
  everyRead?: true
}

/**
 * The configured experiments, one per later call when the transport can fail
 * those, then every read failing, with the first experiment's fault.
 */
export function planExperiments<Fault extends string>(
  experiments: DiscoveryExperiment<Fault>[],
  laterCallFault: Fault | undefined,
  callsPerLoad: number[],
): DiscoveryExperiment<Fault>[] {
  const later =
    laterCallFault === undefined
      ? []
      : laterCalls(callsPerLoad).map((call) => ({
          fault: laterCallFault,
          times: 1,
          call,
        }))
  const everyRead = {
    fault: experiments[0].fault,
    times: EVERY_READ,
    everyRead: true as const,
  }
  return [...experiments, ...later, everyRead]
}

/** What to do with a finding of this classification. */
export function advice(classification: string, everyRead?: true): string {
  if (classification === 'SILENT_EMPTY')
    return 'Inspect the error-to-empty UI branch. Preserve the distinction between a failed read and a successful empty result; consider an error message and retry action. This is a hypothesis to review locally.'
  if (everyRead && classification === 'LOADING_AT_DEADLINE')
    return 'The app was still loading when the observation ended. If it retries for longer, raise the observation window (observationMs over IPC, recoveryTimeoutMs over HTTP) to see what the screen shows once its retries run out.'
  return 'Review the recorded behaviour against product expectations. A finite retry limit or explicit error state is not automatically a defect.'
}

/** An experiment's id, such as rejection-1, rejection-1-call2 or rejection-every-read. */
export function findingId(run: DiscoveryExperiment): string {
  if (run.everyRead) return `${run.fault}-every-read`
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
  everyRead?: true
  /** With everyRead, how many reads failed in each run: the app's attempts, up to the limit. */
  failedReads?: number[]
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
  everyRead?: true
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
      ...(runs[0].everyRead ? { everyRead: true as const } : {}),
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
