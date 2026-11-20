import { classifyObservation, compareRegions } from '../../core/screen.mjs'
import { advice, type DiscoveryExperiment } from './experiment.mjs'
import type { DiscoveryPhase, DiscoveryRun, ReadSnapshot } from './types.mjs'

/** A faulted load, compared with the healthy control before it. */
export function faultedRun<Fault extends string, Snapshot extends ReadSnapshot>(
  planned: DiscoveryExperiment<Fault>,
  healthy: DiscoveryPhase<Fault, Snapshot>,
  result: DiscoveryPhase<Fault, Snapshot>,
): DiscoveryRun<Fault, Snapshot> {
  const { injected } = result.snapshot
  const assessment = classifyObservation({
    baseline: healthy.ui,
    final: result.ui,
    injected,
    // Every read failing takes as many faults as the app makes reads.
    expected: planned.everyRead && injected > 0 ? injected : planned.times,
    recovered: result.ready,
    newErrors: result.newErrors,
  })
  return {
    ...result,
    control: { ui: healthy.ui, snapshot: healthy.snapshot },
    assessment,
    observation: {
      ...compareRegions(healthy.ui, result.ui),
      injected: result.snapshot.injected,
      channels: result.snapshot.channels,
      recoveryMs: result.recoveryMs,
      repeatedReads: result.repeatedReads,
    },
    interpretation: assessment,
  }
}

/** An experiment's finding: the verdict its runs share, or UNSTABLE when they disagree. */
export function findingOf<Fault extends string, Snapshot extends ReadSnapshot>(
  id: string,
  planned: DiscoveryExperiment<Fault>,
  runs: DiscoveryRun<Fault, Snapshot>[],
  {
    observationMs,
    verification,
  }: { observationMs: number; verification: string },
) {
  const consistent = runs.every(
    (r) => r.assessment.classification === runs[0].assessment.classification,
  )
  const assessment = consistent
    ? runs[0].assessment
    : { classification: 'UNSTABLE', kind: 'inconclusive', confidence: 'low' }
  return {
    id,
    ...planned,
    ...(planned.everyRead
      ? { failedReads: runs.map((r) => r.snapshot.injected) }
      : {}),
    ...assessment,
    confirmations: runs.length,
    repeatConfirmed: consistent && runs.length >= 3,
    observationMs,
    advice: advice(assessment.classification, planned.everyRead),
    verification,
  }
}
