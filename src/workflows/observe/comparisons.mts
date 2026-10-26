import type {
  ContentSummary,
  ObservationSample,
  ReadCounts,
} from './report.mjs'

export type ComparisonResult = 'unavailable' | 'unchanged' | 'changed'
export type ComparisonBasis = 'READ_COMPLETION' | 'INTERVAL_RETURN'

interface ContentEvidence {
  interval: number
  fromMs: number
  toMs: number
  presence?: string
  visible: boolean
  content: ContentSummary | null
}

export interface ComparisonFollowUp {
  samples: number
  comparableSamples: number
  unavailableSamples: number
  firstBaselineMatch: ContentEvidence | null
  latest: (ContentEvidence & { result: ComparisonResult }) | null
  summary: string
}

export interface ContentComparison {
  kind: 'observation'
  basis: ComparisonBasis
  interval: number
  result: ComparisonResult
  before: ContentEvidence
  after: ContentEvidence
  completions?: { successes: number; errors: number }
  reads?: ObservationSample['reads']
  summary: string
  note: string
  followUp?: ComparisonFollowUp
}

type TrackedComparison = ContentComparison & { followUp: ComparisonFollowUp }

// Matches the report's cap on comparisons; evidence it discards is not retained.
const MAX_TRACKED = 1000

// Compare samples only; these summaries cannot establish ownership or freshness.
const contentEvidence = (e: ObservationSample): ContentEvidence => ({
  interval: e.interval,
  fromMs: e.fromMs,
  toMs: e.toMs,
  presence: e.ui.presence,
  visible: e.ui.visible,
  content: e.ui.content ?? null,
})

function compareContent(
  before: ContentEvidence,
  after: ContentEvidence,
): ComparisonResult {
  const a = before.content,
    b = after.content
  if (!before.visible || !after.visible || !a || !b) return 'unavailable'
  if (a.truncated || b.truncated) return 'unavailable'
  return a.count === b.count && a.textFingerprint === b.textFingerprint
    ? 'unchanged'
    : 'changed'
}

export function contentComparison(
  basis: ComparisonBasis,
  before: ObservationSample,
  after: ObservationSample,
): ContentComparison {
  const result = compareContent(contentEvidence(before), contentEvidence(after))
  return {
    kind: 'observation',
    basis,
    interval: after.interval,
    result,
    before: contentEvidence(before),
    after: contentEvidence(after),
    ...(basis === 'READ_COMPLETION'
      ? {
          completions: {
            successes: after.before.successes - before.after.successes,
            errors: after.before.errors - before.after.errors,
          },
        }
      : { reads: after.reads }),
    summary: `${basis === 'READ_COMPLETION' ? 'Across observed read completion(s)' : 'On the first sampled content in this interval'}, selected marker text/count comparison: ${result}.`,
    note: 'Ordered normalized visible marker text/count only. Other values, ownership, freshness and changes between samples are unknown. Completion does not imply renderer consumption.',
  }
}

export function comparisonFollowUpSummary(comparison: {
  result?: ComparisonResult
  followUp?: ComparisonFollowUp
}): string {
  const f = comparison.followUp
  if (!f) return '' // Reports from older versions have no follow-up evidence.
  if (!f.samples || !f.latest) return 'No later sample in this interval.'
  const matched = f.firstBaselineMatch
  const prefix =
    comparison.result === 'changed' && matched
      ? `Initially different; a later sample matched the baseline (${matched.fromMs}–${matched.toMs} ms from capture start). `
      : ''
  return `${prefix}Latest follow-up sample (${f.latest.fromMs}–${f.latest.toMs} ms from capture start): ${f.latest.result} against the baseline. ${f.comparableSamples} comparable, ${f.unavailableSamples} unavailable later samples. These samples do not establish continuous visibility or stability.`
}

/** Compares a later sample in the same interval with a comparison's baseline. */
function followUp(comparison: TrackedComparison, event: ObservationSample) {
  const f = comparison.followUp
  const evidence = contentEvidence(event)
  const result = compareContent(comparison.before, evidence)
  f.samples++
  if (result === 'unavailable') f.unavailableSamples++
  else f.comparableSamples++
  f.latest = { ...evidence, result }
  if (result === 'unchanged' && !f.firstBaselineMatch)
    f.firstBaselineMatch = evidence
  f.summary = comparisonFollowUpSummary(comparison)
}

const completed = (counts: ReadCounts) => counts.successes + counts.errors

/**
 * Compares marker content across read completions and on returning to an interval's
 * first content, then follows each comparison through the rest of its interval.
 */
export class ContentComparisons {
  #interval?: number
  #anchor?: ObservationSample
  #lastContent?: ObservationSample
  #returnBaseline?: ObservationSample
  #comparedReturn = false
  #active: TrackedComparison[] = []
  #retained = 0

  add(event: ObservationSample): ContentComparison[] {
    if (this.#interval !== event.interval) this.#enterInterval(event.interval)
    for (const comparison of this.#active) followUp(comparison, event)
    const results = [
      ...this.#intervalReturn(event),
      ...this.#readCompletion(event),
    ]
    for (const comparison of results) {
      if (this.#retained >= MAX_TRACKED) break
      this.#active.push(
        Object.assign(comparison, {
          followUp: {
            samples: 0,
            comparableSamples: 0,
            unavailableSamples: 0,
            firstBaselineMatch: null,
            latest: null,
            summary: 'No later sample in this interval.',
          },
        }),
      )
      this.#retained++
    }
    return results
  }

  #enterInterval(index: number) {
    this.#interval = index
    this.#anchor = undefined
    this.#returnBaseline = this.#lastContent
    this.#comparedReturn = false
    this.#active = [] // Later intervals cannot resolve an earlier comparison.
  }

  /** The interval's first content against the last content of the interval before. */
  #intervalReturn(event: ObservationSample): ContentComparison[] {
    if (!event.ui.visible || (event.ui.contentCount ?? 0) <= 0) return []
    const baseline = this.#comparedReturn ? undefined : this.#returnBaseline
    this.#comparedReturn = true
    this.#lastContent = event
    return baseline
      ? [contentComparison('INTERVAL_RETURN', baseline, event)]
      : []
  }

  #readCompletion(event: ObservationSample): ContentComparison[] {
    const anchor = this.#anchor
    if (!anchor || completed(event.after) <= completed(anchor.after)) {
      this.#anchor = event
      return []
    }
    // A completion during the UI read is ambiguous. Retain the earlier
    // sample until a later UI read is bracketed by settled counters.
    if (completed(event.before) !== completed(event.after)) return []
    this.#anchor = event
    return [contentComparison('READ_COMPLETION', anchor, event)]
  }
}

/** One line per interval instead of one per comparison. */
export function comparisonDigest(report: {
  comparisons?: ContentComparison[]
}): string[] {
  const byInterval = new Map<number, Record<string, number>>()
  for (const c of report.comparisons ?? []) {
    const entry = byInterval.get(c.interval) ?? {}
    const key = digestKey(c)
    entry[key] = (entry[key] ?? 0) + 1
    byInterval.set(c.interval, entry)
  }
  return [...byInterval].map(
    ([index, entry]) =>
      `Interval ${index} comparisons: ${Object.entries(entry)
        .map(([key, n]) => `${n} ${key}`)
        .join(', ')}.`,
  )
}

function digestKey(c: ContentComparison) {
  const basis =
    c.basis === 'READ_COMPLETION' ? 'read-completion' : 'interval-return'
  const laterMatched =
    c.basis === 'INTERVAL_RETURN' &&
    c.result === 'changed' &&
    c.followUp?.firstBaselineMatch
  return `${basis} ${c.result}${laterMatched ? ' (later matched)' : ''}`
}
