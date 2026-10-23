import { createHash } from 'node:crypto'
import type { RecordedAction, SelectorSpec } from '../workflows/observe/kit.mjs'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** What an observation reads; a plain region selector reads the region alone. */
export interface ObservationReadInput {
  regionSelector?: string | null
  contentSelector: SelectorSpec
  detail?: string
  kitToken?: string
  rows?: {
    selector: SelectorSpec
    key?: SelectorSpec
    state?: SelectorSpec
    markers?: SelectorSpec[]
  }
}

type Distributions = Record<string, Record<string, Record<string, number>>>

/** A region as read in the page. Raw text never leaves Node: summarizeRegion hashes it. */
export interface RegionRead {
  presence?: 'absent' | 'hidden' | 'visible'
  contentCount?: number
  content?: { texts: string[]; truncated: boolean }
  rows?: {
    truncated: boolean
    /** `marker` is the index of the first configured marker found in the row. */
    items: { key: string; state: string | null; marker?: number }[]
  }
  truncated?: boolean
  visible: boolean
  online: boolean
  text?: string
  structure?: Record<string, number>
  groups?: Record<string, number>
  distributions?: Distributions
  region?: 'selected' | 'body' | 'main'
  items?: number
  images?: number
  links?: number
  buttons?: number
  loading?: boolean
  empty?: boolean
  error?: boolean
  retry?: boolean
  actions?: RecordedAction[]
  rendererReadMs?: number
}

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

// Runs in the page. Neither raw text nor attribute values are persisted.
export function readRegion(
  selector: string | ObservationReadInput | null | undefined,
): RegionRead {
  const readStarted = performance.now()
  const observation =
    typeof selector === 'object' && selector !== null ? selector : null
  // Observation may use the capture's in-page kit for text/role selectors, rows and actions.
  const kit = observation ? globalThis.__recoveryProbeObserve : undefined
  if (observation?.kitToken && kit?.token !== observation.kitToken)
    throw new Error(
      'OBSERVER_KIT_MISSING: the page was replaced or another observation owns it',
    )
  const select = (root: ParentNode, spec: SelectorSpec): Element[] =>
    kit ? kit.select(root, spec) : [...root.querySelectorAll(spec as string)]
  const normalize = (value: unknown) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const actions = () =>
    observation?.kitToken ? kit?.drainActions() : undefined
  const finish = (value: RegionRead): RegionRead =>
    observation
      ? {
          ...value,
          actions: actions(),
          rendererReadMs: performance.now() - readStarted,
        }
      : value
  let regionSelector = typeof selector === 'string' ? selector : null
  if (observation) {
    regionSelector = observation.regionSelector ?? null
    select(document, observation.contentSelector) // Validate even when the region is absent.
  }
  const roots = regionSelector
    ? document.querySelectorAll(regionSelector)
    : null
  if (observation && roots?.length === 0)
    return finish({
      presence: 'absent',
      contentCount: 0,
      visible: document.visibilityState === 'visible',
      online: navigator.onLine,
    })
  if (roots && roots.length !== 1)
    throw new Error('regionSelector must identify one region')
  const root = (roots?.[0] ??
    document.querySelector('main, [role="main"]') ??
    document.body) as HTMLElement
  // Cache only within this synchronous read: no DOM references survive a sample.
  const visibility = new WeakMap<Element, boolean>()
  const visible = (e: Element): boolean => {
    if (!visibility.has(e)) {
      const style = getComputedStyle(e)
      visibility.set(
        e,
        !!(
          e.getClientRects().length &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        ),
      )
    }
    return visibility.get(e) as boolean
  }
  if (observation && !visible(root))
    return finish({
      presence: 'hidden',
      contentCount: 0,
      visible: document.visibilityState === 'visible',
      online: navigator.onLine,
    })
  let content: RegionRead['content'], rows: RegionRead['rows']
  if (observation) {
    const matches = select(root, observation.contentSelector)
    const texts: string[] = []
    let remaining = 200000,
      truncated = matches.length > 1000
    for (const e of [...matches].slice(0, 1000)) {
      if (!visible(e)) continue
      const text = normalize((e as HTMLElement).innerText)
      if (text.length > remaining) truncated = true
      texts.push(text.slice(0, remaining))
      remaining = Math.max(0, remaining - text.length)
    }
    content = { texts, truncated }
    // Row key and state text are returned transiently; Node hashes keys and keeps only allowlisted states.
    if (observation.rows) {
      const r = observation.rows
      const elements = select(root, r.selector).filter(visible)
      rows = {
        truncated: elements.length > 500,
        items: elements.slice(0, 500).map((element) => {
          const keyElement = r.key
            ? select(element, r.key).find(visible)
            : element
          const stateElement = r.state
            ? select(element, r.state).find(visible)
            : undefined
          const marker = (r.markers ?? []).findIndex((spec) =>
            select(element, spec).some(visible),
          )
          return {
            key: keyElement
              ? normalize((keyElement as HTMLElement).innerText).slice(0, 500)
              : '',
            state: stateElement
              ? normalize((stateElement as HTMLElement).innerText).slice(0, 100)
              : null,
            ...(marker === -1 ? {} : { marker }),
          }
        }),
      }
    }
    if (observation.detail === 'content')
      return finish({
        presence: 'visible',
        contentCount: texts.length,
        content,
        rows,
        truncated,
        visible: document.visibilityState === 'visible',
        online: navigator.onLine,
      })
  }
  const nodes = [...root.querySelectorAll('*')].filter(visible).slice(0, 5000)
  const count = (s: string) =>
    [...root.querySelectorAll(s)].filter(visible).length
  const text = (root.innerText ?? '').replace(/\s+/g, ' ').trim()
  const tag = (e: Element) => e.tagName.toLowerCase()
  const shape = (e: Element) =>
    [tag(e), ...[...e.children].filter(visible).slice(0, 20).map(tag)].join('/')
  const path = (e: Element) => {
    const parts: number[] = []
    while (e !== root && e.parentElement) {
      parts.unshift([...e.parentElement.children].indexOf(e))
      e = e.parentElement
    }
    return parts.join('/')
  }
  const groups: Record<string, number> = {},
    distributions: Distributions = {},
    structure: Record<string, number> = {}
  for (const e of nodes) structure[tag(e)] = (structure[tag(e)] ?? 0) + 1
  // Match repeated structural families at stable parent positions. No app classes,
  // endpoint names, visible strings or framework knowledge are used as selectors.
  for (const parent of [root, ...nodes]) {
    if (Object.keys(groups).length >= 100) break
    if (parent.closest('nav, header, footer')) continue
    const families = new Map<string, Element[]>()
    for (const child of [...parent.children].filter(visible)) {
      if (['script', 'style', 'option'].includes(tag(child))) continue
      const key = shape(child)
      const family = families.get(key) ?? []
      family.push(child)
      families.set(key, family)
    }
    for (const [shapeKey, children] of families) {
      if (children.length < 2) continue
      const key = `${path(parent)}:${shapeKey}`
      groups[key] = children.length
      // Column/value shifts are facts, not claims about roles or permissions.
      const values: Record<string, Record<string, number>> = {}
      children.slice(0, 200).forEach((child) => {
        const cells = [...child.children].filter(visible)
        ;(cells.length ? cells : [child])
          .slice(0, 20)
          .forEach((cell, index) => {
            const value = ((cell as HTMLElement).innerText ?? '')
              .replace(/\s+/g, ' ')
              .trim()
            if (!value) return
            const bucket = (values[index] ??= Object.create(null))
            bucket[value] = (bucket[value] ?? 0) + 1
          })
      })
      distributions[key] = values
    }
  }
  return finish({
    text,
    structure,
    groups,
    distributions,
    ...(observation
      ? {
          presence: 'visible' as const,
          contentCount: content?.texts.length,
          content,
          rows,
        }
      : {}),
    region: regionSelector
      ? 'selected'
      : root === document.body
        ? 'body'
        : 'main',
    truncated:
      root.querySelectorAll('*').length > 5000 || Boolean(content?.truncated),
    visible: document.visibilityState === 'visible',
    online: navigator.onLine,
    items: count(
      'tbody tr, [role="row"]:not(:has([role="columnheader"])), [role="listitem"], li',
    ),
    images: count('img, [role="img"], svg'),
    links: count('a[href]'),
    buttons: count('button, [role="button"]'),
    loading:
      count('[role="progressbar"], [aria-busy="true"]') > 0 ||
      /\b(loading|laden|lädt)\b/i.test(text),
    empty:
      /\b(no (files|items|results|data)|nothing (here|found)|empty|keine (dateien|einträge|ergebnisse))\b/i.test(
        text,
      ),
    error:
      count('[role="alert"]') > 0 ||
      /\b(error|failed|unable to|something went wrong|fehler|fehlgeschlagen)\b/i.test(
        text,
      ),
    retry: [...root.querySelectorAll('button, [role="button"]')].some(
      (e) =>
        visible(e) &&
        /\b(retry|try again|erneut versuchen|wiederholen)\b/i.test(
          (e as HTMLElement).innerText || e.getAttribute('aria-label') || '',
        ),
    ),
  })
}
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
  const values: Distributions = {}
  for (const [family, columns] of Object.entries(distributions)) {
    values[family] = {}
    for (const [column, distribution] of Object.entries(columns)) {
      values[family][column] = Object.fromEntries(
        Object.entries(distribution)
          .map(([value, count]) => [hash(value), count] as const)
          .sort(),
      )
    }
  }
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
export function compareRegions(before: RegionSummary, after: RegionSummary) {
  const lostFamilies = Object.entries(before.groups ?? {})
    .filter(([key, count]) => count >= 2 && !after.groups?.[key])
    .map(([family, count]) => ({ family, before: count, after: 0 }))
  const distributionChanges: {
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
        distributionChanges.push({
          family,
          column,
          before: values,
          after: next,
        })
    }
  }
  return {
    before: {
      items: before.items ?? 0,
      images: before.images ?? 0,
      groups: before.groups ?? {},
      structure: before.structure ?? {},
    },
    after: {
      items: after.items ?? 0,
      images: after.images ?? 0,
      groups: after.groups ?? {},
      structure: after.structure ?? {},
    },
    indicators: {
      loading: after.loading,
      error: after.error,
      retry: after.retry,
      empty: after.empty,
    },
    lostFamilies,
    distributionChanges,
    structureChanged:
      before.structuralFingerprint !== after.structuralFingerprint,
    textChanged: before.textFingerprint !== after.textFingerprint,
    regionReplacedCandidate:
      lostFamilies.length > 0 &&
      before.structuralFingerprint !== after.structuralFingerprint,
    contentLoss:
      ((before.items ?? 0) > 0 && after.items === 0) ||
      ((before.images ?? 0) > 0 && after.images === 0) ||
      lostFamilies.length > 0,
  }
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
  const result = (
    classification: string,
    kind: string,
    confidence = 'medium',
  ) => ({
    classification,
    kind,
    confidence,
  })
  if (injected !== expected)
    return result('FAULT_NOT_TRIGGERED', 'inconclusive', 'high')
  if (newErrors > 0) return result('UNCAUGHT_ERROR', 'suspected-defect')
  if (recovered) return result('RECOVERED', 'observation', 'high')
  if (final.error || final.retry)
    return result('ERROR_OR_RETRY_SHOWN', 'observation')
  if (final.loading) return result('LOADING_AT_DEADLINE', 'decision-needed')
  if (!baseline.empty && (baseline.textLength ?? 0) > 0 && final.empty)
    return result('SILENT_EMPTY', 'suspected-defect')
  if (compareRegions(baseline, final).contentLoss)
    return result('CONTENT_LOSS', 'suspected-defect')
  return result('UI_DIFFERENCE_AT_DEADLINE', 'decision-needed', 'low')
}
