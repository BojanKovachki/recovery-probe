import type { RecordedAction } from '../workflows/observe/kit.mjs'
import type { SelectorSpec } from './selector.mjs'

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

export type Distributions = Record<
  string,
  Record<string, Record<string, number>>
>

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

/**
 * Reads the region in the page. Neither raw text nor attribute values are persisted.
 * Playwright sends only this function's source, so its helpers live inside it.
 */
// eslint-disable-next-line max-lines-per-function -- serialized into the page as one function
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
  const innerText = (e: Element) => normalize((e as HTMLElement).innerText)
  const page = () => ({
    visible: document.visibilityState === 'visible',
    online: navigator.onLine,
  })
  const finish = (value: RegionRead): RegionRead =>
    observation
      ? {
          ...value,
          actions: observation.kitToken ? kit?.drainActions() : undefined,
          rendererReadMs: performance.now() - readStarted,
        }
      : value

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

  const regionOf = (regionSelector: string | null) => {
    const roots = regionSelector
      ? document.querySelectorAll(regionSelector)
      : null
    if (observation && roots?.length === 0) return null
    if (roots && roots.length !== 1)
      throw new Error('regionSelector must identify one region')
    return (roots?.[0] ??
      document.querySelector('main, [role="main"]') ??
      document.body) as HTMLElement
  }

  const contentOf = (root: Element, spec: SelectorSpec) => {
    const matches = select(root, spec)
    const texts: string[] = []
    let remaining = 200000
    let truncated = matches.length > 1000
    for (const e of [...matches].slice(0, 1000)) {
      if (!visible(e)) continue
      const text = innerText(e)
      if (text.length > remaining) truncated = true
      texts.push(text.slice(0, remaining))
      remaining = Math.max(0, remaining - text.length)
    }
    return { texts, truncated }
  }

  // Row key and state text are returned transiently; Node hashes keys and keeps only allowlisted states.
  const rowsOf = (
    root: Element,
    r: NonNullable<ObservationReadInput['rows']>,
  ): RegionRead['rows'] => {
    const row = (element: Element) => {
      const keyElement = r.key ? select(element, r.key).find(visible) : element
      const stateElement = r.state
        ? select(element, r.state).find(visible)
        : undefined
      const marker = (r.markers ?? []).findIndex((spec) =>
        select(element, spec).some(visible),
      )
      return {
        key: keyElement ? innerText(keyElement).slice(0, 500) : '',
        state: stateElement ? innerText(stateElement).slice(0, 100) : null,
        ...(marker === -1 ? {} : { marker }),
      }
    }
    const elements = select(root, r.selector).filter(visible)
    return {
      truncated: elements.length > 500,
      items: elements.slice(0, 500).map(row),
    }
  }

  const tag = (e: Element) => e.tagName.toLowerCase()
  const shape = (e: Element) =>
    [tag(e), ...[...e.children].filter(visible).slice(0, 20).map(tag)].join('/')
  const path = (root: Element, e: Element) => {
    const parts: number[] = []
    while (e !== root && e.parentElement) {
      parts.unshift([...e.parentElement.children].indexOf(e))
      e = e.parentElement
    }
    return parts.join('/')
  }
  // Column/value shifts are facts, not claims about roles or permissions.
  const columnValues = (children: Element[]) => {
    const values: Record<string, Record<string, number>> = {}
    children.slice(0, 200).forEach((child) => {
      const cells = [...child.children].filter(visible)
      ;(cells.length ? cells : [child]).slice(0, 20).forEach((cell, index) => {
        const value = normalize((cell as HTMLElement).innerText ?? '')
        if (!value) return
        const bucket = (values[index] ??= Object.create(null))
        bucket[value] = (bucket[value] ?? 0) + 1
      })
    })
    return values
  }
  const familiesUnder = (parent: Element) => {
    const families = new Map<string, Element[]>()
    for (const child of [...parent.children].filter(visible)) {
      if (['script', 'style', 'option'].includes(tag(child))) continue
      const key = shape(child)
      const family = families.get(key) ?? []
      family.push(child)
      families.set(key, family)
    }
    return families
  }
  // Repeated structural families at stable parent positions. No app classes, endpoint
  // names, visible strings or framework knowledge are used as selectors.
  const familiesOf = (root: Element, nodes: Element[]) => {
    const structure: Record<string, number> = {}
    const groups: Record<string, number> = {}
    const distributions: Distributions = {}
    for (const e of nodes) structure[tag(e)] = (structure[tag(e)] ?? 0) + 1
    for (const parent of [root, ...nodes]) {
      if (Object.keys(groups).length >= 100) break
      if (parent.closest('nav, header, footer')) continue
      for (const [shapeKey, children] of familiesUnder(parent)) {
        if (children.length < 2) continue
        const key = `${path(root, parent)}:${shapeKey}`
        groups[key] = children.length
        distributions[key] = columnValues(children)
      }
    }
    return { structure, groups, distributions }
  }

  // Counts and recognised wording that hint at loading, empty, error and retry states.
  const indicatorsOf = (root: Element, text: string) => {
    const count = (s: string) =>
      [...root.querySelectorAll(s)].filter(visible).length
    return {
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
    }
  }

  type Observed = {
    content: NonNullable<RegionRead['content']>
    rows: RegionRead['rows']
  }

  const structuralRead = (
    root: HTMLElement,
    regionSelector: string | null,
    observed?: Observed,
  ): RegionRead => {
    const nodes = [...root.querySelectorAll('*')].filter(visible).slice(0, 5000)
    const text = (root.innerText ?? '').replace(/\s+/g, ' ').trim()
    return {
      text,
      ...familiesOf(root, nodes),
      ...(observed
        ? {
            presence: 'visible' as const,
            contentCount: observed.content.texts.length,
            content: observed.content,
            rows: observed.rows,
          }
        : {}),
      region: regionSelector
        ? 'selected'
        : root === document.body
          ? 'body'
          : 'main',
      truncated:
        root.querySelectorAll('*').length > 5000 ||
        Boolean(observed?.content.truncated),
      ...page(),
      ...indicatorsOf(root, text),
    }
  }

  const contentRead = ({ content, rows }: Observed): RegionRead => ({
    presence: 'visible',
    contentCount: content.texts.length,
    content,
    rows,
    truncated: content.truncated,
    ...page(),
  })

  const read = (): RegionRead => {
    const regionSelector = observation
      ? (observation.regionSelector ?? null)
      : typeof selector === 'string'
        ? selector
        : null
    if (observation) select(document, observation.contentSelector) // Validate even when the region is absent.
    const root = regionOf(regionSelector)
    if (!root) return { presence: 'absent', contentCount: 0, ...page() }
    if (!observation) return structuralRead(root, regionSelector)
    if (!visible(root))
      return { presence: 'hidden', contentCount: 0, ...page() }
    const observed = {
      content: contentOf(root, observation.contentSelector),
      rows: observation.rows ? rowsOf(root, observation.rows) : undefined,
    }
    return observation.detail === 'content'
      ? contentRead(observed)
      : structuralRead(root, regionSelector, observed)
  }

  return finish(read())
}
