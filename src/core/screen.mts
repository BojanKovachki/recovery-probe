import { createHash } from 'node:crypto'
import type { Distributions, RegionRead } from './region-read.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export interface RegionSummary extends Omit<
  RegionRead,
  'text' | 'content' | 'rows' | 'actions' | 'rendererReadMs'
> {
  content?: {
    basis: 'ordered-visible-marker-text'
    count: number
    textLength: number
    textFingerprint: string
    truncated: boolean
  }
  textLength?: number
  textFingerprint?: string
  structuralFingerprint?: string
  fingerprint?: string
}

const hashedDistributions = (distributions: Distributions): Distributions =>
  Object.fromEntries(
    Object.entries(distributions).map(([family, columns]) => [
      family,
      Object.fromEntries(
        Object.entries(columns).map(([column, distribution]) => [
          column,
          Object.fromEntries(
            Object.entries(distribution)
              .map(([value, count]) => [hash(value), count] as const)
              .sort(),
          ),
        ]),
      ),
    ]),
  )

/** The region with its text and values replaced by hashes, so a report can keep it. */
export function summarizeRegion(raw: RegionRead): RegionSummary {
  const {
    text,
    distributions = {},
    content,
    rows: _rows,
    actions: _actions,
    rendererReadMs: _timing,
    ...summary
  } = raw
  const result: RegionSummary = summary
  if (content)
    result.content = {
      basis: 'ordered-visible-marker-text',
      count: content.texts.length,
      textLength: content.texts.reduce((sum, value) => sum + value.length, 0),
      textFingerprint: hash(JSON.stringify(content.texts)),
      truncated: content.truncated,
    }
  if (text === undefined) return result
  const values = hashedDistributions(distributions)
  const structuralFingerprint = hash(
    JSON.stringify({ structure: result.structure, groups: result.groups }),
  )
  return {
    ...result,
    distributions: values,
    textLength: text.length,
    textFingerprint: hash(text),
    structuralFingerprint,
    fingerprint: hash(
      JSON.stringify([text, result.structure, result.groups, values]),
    ),
  }
}

const counts = (region: RegionSummary) => ({
  items: region.items ?? 0,
  images: region.images ?? 0,
  groups: region.groups ?? {},
  structure: region.structure ?? {},
})

const lostFamiliesOf = (before: RegionSummary, after: RegionSummary) =>
  Object.entries(before.groups ?? {})
    .filter(([key, count]) => count >= 2 && !after.groups?.[key])
    .map(([family, count]) => ({ family, before: count, after: 0 }))

function distributionChangesOf(before: RegionSummary, after: RegionSummary) {
  const changes: {
    family: string
    column: string
    before: Record<string, number>
    after: Record<string, number>
  }[] = []
  for (const [family, columns] of Object.entries(before.distributions ?? {})) {
    const afterColumns = after.distributions?.[family]
    if (!afterColumns) continue
    for (const [column, values] of Object.entries(columns)) {
      const next = afterColumns[column] ?? {}
      if (JSON.stringify(values) !== JSON.stringify(next))
        changes.push({ family, column, before: values, after: next })
    }
  }
  return changes
}

/** What changed between two summaries of the same region. */
export function compareRegions(before: RegionSummary, after: RegionSummary) {
  const lostFamilies = lostFamiliesOf(before, after)
  const structureChanged =
    before.structuralFingerprint !== after.structuralFingerprint
  return {
    before: counts(before),
    after: counts(after),
    indicators: {
      loading: after.loading,
      error: after.error,
      retry: after.retry,
      empty: after.empty,
    },
    lostFamilies,
    distributionChanges: distributionChangesOf(before, after),
    structureChanged,
    textChanged: before.textFingerprint !== after.textFingerprint,
    regionReplacedCandidate: lostFamilies.length > 0 && structureChanged,
    contentLoss:
      ((before.items ?? 0) > 0 && after.items === 0) ||
      ((before.images ?? 0) > 0 && after.images === 0) ||
      lostFamilies.length > 0,
  }
}

const assessment = (
  classification: string,
  kind: string,
  confidence = 'medium',
) => ({ classification, kind, confidence })

/** What the screen showed at the deadline, when the read did not recover. */
function shownAtDeadline(baseline: RegionSummary, final: RegionSummary) {
  if (final.error || final.retry)
    return assessment('ERROR_OR_RETRY_SHOWN', 'observation')
  if (final.loading) return assessment('LOADING_AT_DEADLINE', 'decision-needed')
  if (!baseline.empty && (baseline.textLength ?? 0) > 0 && final.empty)
    return assessment('SILENT_EMPTY', 'suspected-defect')
  if (compareRegions(baseline, final).contentLoss)
    return assessment('CONTENT_LOSS', 'suspected-defect')
  return assessment('UI_DIFFERENCE_AT_DEADLINE', 'decision-needed', 'low')
}

export function classifyObservation({
  baseline,
  final,
  injected,
  expected,
  recovered,
  newErrors = 0,
}: {
  baseline: RegionSummary
  final: RegionSummary
  injected: number
  expected: number
  recovered: boolean
  newErrors?: number
}) {
  if (injected !== expected)
    return assessment('FAULT_NOT_TRIGGERED', 'inconclusive', 'high')
  if (newErrors > 0) return assessment('UNCAUGHT_ERROR', 'suspected-defect')
  if (recovered) return assessment('RECOVERED', 'observation', 'high')
  return shownAtDeadline(baseline, final)
}
