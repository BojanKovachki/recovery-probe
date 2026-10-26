import type { compareRegions } from '../../core/screen.mjs'
import type { RefreshConfig } from './config.mjs'
import type {
  Observed,
  RefreshFinding,
  RefreshKind,
  RefreshRun,
} from './types.mjs'

/** A faulted refresh as observed after its trigger, before any second trigger. */
export interface FaultedRefresh {
  spontaneous: Observed
  observation: ReturnType<typeof compareRegions>
  baselineFingerprint: string | undefined
  times: number
  /** Whether the page threw during the run. */
  pageErrors: boolean
}

/** What the screen and the read counters show by the end of a faulted refresh. */
export function classifyRefresh(r: FaultedRefresh): {
  code: string
  kind: RefreshKind
} {
  const { snapshot, ui } = r.spontaneous
  if (snapshot.injected === 0)
    return { code: 'TRIGGER_NO_READ', kind: 'inconclusive' }
  if (snapshot.injected !== r.times)
    return { code: 'FAULT_NOT_TRIGGERED', kind: 'inconclusive' }
  if (Object.values(snapshot.channels).some((c) => c.errors) || r.pageErrors)
    return { code: 'EXPERIMENT_CONFOUNDED', kind: 'inconclusive' }
  const showsBaseline = ui.fingerprint === r.baselineFingerprint
  if (snapshot.successfulAfterFault > 0 && showsBaseline && !ui.loading)
    return { code: 'RECOVERED_AUTOMATICALLY', kind: 'observation' }
  if (r.observation.contentLoss)
    return { code: 'CONTENT_LOSS_ON_REFRESH', kind: 'suspected-defect' }
  if (showsBaseline) return { code: 'CONTENT_KEPT', kind: 'observation' }
  return { code: 'UI_DIFFERENCE_AT_DEADLINE', kind: 'decision-needed' }
}

/** What a second trigger after the observation window achieved. */
export function secondTriggerResult(
  after: Observed,
  target: string,
  baselineFingerprint: string | undefined,
): NonNullable<RefreshRun['secondTriggerResult']> {
  const showsBaseline = after.ui.fingerprint === baselineFingerprint
  if (
    after.snapshot.channels[target].successes > 0 &&
    showsBaseline &&
    !after.ui.loading
  )
    return 'RECOVERED_AFTER_TRIGGER'
  return showsBaseline
    ? 'NO_REFRESH_SUCCESS_OBSERVED'
    : 'NOT_RECOVERED_WITHIN_WINDOW'
}

/** The experiment's finding: the runs' shared outcome, or why there is none. */
export function refreshFindings(
  results: RefreshRun[],
  c: RefreshConfig,
): RefreshFinding[] {
  const completed = results.filter((r) => r.stage === 'completed')
  const consistent =
    completed.length === c.repeats &&
    completed.every((r) => r.code === completed[0].code)
  const finding: RefreshFinding = {
    id: `${c.trigger.name}-${c.fault}-${c.times}`,
    classification: consistent ? completed[0].code! : 'INCOMPLETE_EXPERIMENT',
    kind: consistent ? completed[0].kind! : 'inconclusive',
    completedRuns: completed.length,
    plannedRuns: c.repeats,
    repeatConsistent: consistent,
    repeatConfirmed:
      consistent && c.repeats === 3 && completed[0].kind !== 'inconclusive',
  }
  if (results[0]?.code === 'TRIGGER_NO_READ' && !completed.length)
    finding.classification = 'TRIGGER_NO_READ'
  return [finding]
}
