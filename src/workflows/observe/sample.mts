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

/**
 * The interval's contentLoaded after `event`: the start of the latest stretch in which the content
 * showed with every image loaded or failed. A change to the content or its images starts a new one.
 */
export function contentLoaded(
  current: ObservationInterval['contentLoaded'],
  event: TimelineEvent,
  previous: TimelineEvent | undefined,
): ObservationInterval['contentLoaded'] {
  const images = event.ui.contentImages
  if (
    !showsContent(event) ||
    !images ||
    images.loaded + images.failed < images.total
  )
    return null
  const unchanged =
    previous?.ui.content?.textFingerprint ===
      event.ui.content?.textFingerprint &&
    previous?.ui.contentImages?.total === images.total
  if (current && unchanged) return current
  return {
    fromMs: event.fromMs,
    toMs: event.toMs,
    images: images.total,
    failedImages: images.failed,
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

// Each interval's last sample, to tell whether the content changed since.
const lastSamples = new WeakMap<ObservationInterval, TimelineEvent>()

/**
 * Adds one sample to its interval's content timing. Returns the CONTENT_BEFORE_READ finding to
 * raise, at most one per interval.
 */
export function addContentSample(
  interval: ObservationInterval,
  event: TimelineEvent,
  contentImages: boolean,
): ContentBeforeReadFinding | null {
  if (!interval.firstContent)
    interval.firstContent = firstContent(event, interval)
  if (contentImages)
    interval.contentLoaded = contentLoaded(
      interval.contentLoaded,
      event,
      lastSamples.get(interval),
    )
  lastSamples.set(interval, event)
  if (interval.findings.includes('CONTENT_BEFORE_READ')) return null
  return contentBeforeRead(event)
}
