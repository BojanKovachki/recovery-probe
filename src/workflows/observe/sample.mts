import { observationSummary } from './summaries.mjs'
import {
  type ContentBeforeReadFinding,
  type ObservationInterval,
  type TimelineEvent,
} from './report.mjs'

export const showsContent = (event: TimelineEvent) =>
  event.ui.visible && (event.ui.contentCount ?? 0) > 0

/** When `event` first showed content in `interval`, or null if it shows none. */
export function firstContent(
  event: TimelineEvent,
  interval: ObservationInterval,
): ObservationInterval['firstContent'] {
  if (!showsContent(event)) return null
  return {
    fromMs: event.fromMs,
    toMs: event.toMs,
    alreadyPresentAtFirstSample: interval.samples === 0,
    reads: event.reads,
    lastReadAgeMs: event.lastReadAgeMs,
    lastCompletionAgeMs: event.lastCompletionAgeMs,
  }
}

/** CONTENT_BEFORE_READ when `event` shows content before any read completed in its interval. */
export function contentBeforeRead(
  event: TimelineEvent,
): ContentBeforeReadFinding | null {
  const reads = event.reads
  if (!showsContent(event) || reads.successes + reads.errors !== 0) return null
  const finding: ContentBeforeReadFinding = {
    code: 'CONTENT_BEFORE_READ',
    kind: 'observation',
    interval: event.interval,
    fromMs: event.fromMs,
    toMs: event.toMs,
    basis:
      reads.calls === 0 && reads.pendingAtStart === 0
        ? 'NO_READ_OBSERVED_IN_INTERVAL'
        : 'NO_COMPLETION_OBSERVED_IN_INTERVAL',
    reads,
    lastReadAgeMs: event.lastReadAgeMs,
    lastCompletionAgeMs: event.lastCompletionAgeMs,
    note: 'The configured content marker is visible. This does not establish cache origin, ownership, a mount boundary, or a defect; earlier and unobserved reads are possible.',
  }
  finding.summary = observationSummary(finding)
  return finding
}
