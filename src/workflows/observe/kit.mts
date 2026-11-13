// In-page helpers for fault-free observation. Installed once per capture without
// reloading; removed at the end. Records only configured action names, times and
// whether the browser marked the click as a real user input.
import type { SelectorSpec } from '../../core/selector.mjs'

export interface ObservedActionConfig {
  name: string
  selector: SelectorSpec
}

export interface RecordedAction {
  name: string
  at: number
  trusted: boolean
}

type ImageState = 'failed' | 'loaded' | 'pending'

/** The `<img>` elements and CSS background images in the given elements; settled ones loaded or failed. */
export interface ContentImages {
  total: number
  loaded: number
  failed: number
  truncated: boolean
}

export interface ObserverKit {
  token: string
  select(root: ParentNode, spec: SelectorSpec): Element[]
  normalize(value: unknown): string
  imagesIn(elements: Element[]): ContentImages
  lastPolledAt(): number
  drainActions(): RecordedAction[]
  stop(): void
}

declare global {
  // The in-page kit for the capture that owns this page.
  var __recoveryProbeObserve: ObserverKit | undefined
}

// Runs in the page. Self-contained: page.evaluate serializes this function.
// eslint-disable-next-line max-lines-per-function -- serialized into the page as one function
export function installObserverKit({
  token,
  actions,
  validate = [],
}: {
  token: string
  actions: ObservedActionConfig[]
  validate?: SelectorSpec[]
}): boolean {
  const existing = globalThis.__recoveryProbeObserve
  if (existing) {
    if (existing.token === token) return true
    // A capture polls its kit on every sample; one unpolled for 15 s was abandoned (for example a crashed CLI).
    if (Date.now() - existing.lastPolledAt() < 15000)
      throw new Error(
        'OBSERVER_ALREADY_ACTIVE: another observation owns this page',
      )
    existing.stop()
  }
  const normalize = (value: unknown) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  // The DOM has no load state for a CSS background, so a probe image per URL tracks it.
  // The page is loading the same URL, so the probe shares its request or cache entry.
  const backgrounds = new Map<string, ImageState>()
  const backgroundState = (url: string): ImageState => {
    const known = backgrounds.get(url)
    if (known) return known
    backgrounds.set(url, 'pending')
    const probe = new Image()
    probe.onload = () => backgrounds.set(url, 'loaded')
    probe.onerror = () => backgrounds.set(url, 'failed')
    probe.src = url
    return 'pending'
  }
  const imageStatesOf = (node: Element): ImageState[] => {
    const urls =
      getComputedStyle(node).backgroundImage.matchAll(/url\("?(.*?)"?\)/g)
    const states = [...urls].map((match) => backgroundState(match[1]))
    if (!(node instanceof HTMLImageElement) || !node.getAttribute('src'))
      return states
    if (node.complete)
      return [...states, node.naturalWidth > 0 ? 'loaded' : 'failed']
    // A lazy image out of view loads only once scrolled to, so it is not waited for.
    return node.loading === 'lazy' && !inView(node)
      ? states
      : [...states, 'pending']
  }
  const inView = (node: Element) => {
    const { top, bottom, left, right } = node.getBoundingClientRect()
    return bottom > 0 && top < innerHeight && right > 0 && left < innerWidth
  }
  const imagesIn = (elements: Element[]): ContentImages => {
    const nodes = elements.flatMap((e) => [e, ...e.querySelectorAll('*')])
    const states = nodes.slice(0, 2000).flatMap(imageStatesOf)
    const count = (state: ImageState) =>
      states.filter((value) => value === state).length
    return {
      total: states.length,
      loaded: count('loaded'),
      failed: count('failed'),
      truncated: nodes.length > 2000,
    }
  }
  const implicitRole = (e: Element) => {
    const tag = e.tagName.toLowerCase()
    if (tag === 'button') return 'button'
    if (tag === 'a' && e.hasAttribute('href')) return 'link'
    if (tag === 'input') {
      const type = (e.getAttribute('type') || 'text').toLowerCase()
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      return type === 'checkbox' || type === 'radio' ? type : 'textbox'
    }
    return (
      (
        {
          tr: 'row',
          td: 'cell',
          th: 'columnheader',
          li: 'listitem',
          ul: 'list',
          ol: 'list',
          table: 'table',
          img: 'img',
          textarea: 'textbox',
          select: 'combobox',
          nav: 'navigation',
          main: 'main',
          dialog: 'dialog',
        } as Record<string, string>
      )[tag] ?? (/^h[1-6]$/.test(tag) ? 'heading' : null)
    )
  }
  const roleOf = (e: Element) =>
    normalize(e.getAttribute('role')).split(' ')[0] || implicitRole(e)
  // Approximation of the accessible name: aria-label, aria-labelledby, visible text, title/alt.
  const nameOf = (e: Element) => {
    const labelledBy = normalize(e.getAttribute('aria-labelledby'))
    const byIds = labelledBy
      ? labelledBy
          .split(' ')
          .map((id) => document.getElementById(id)?.innerText ?? '')
          .join(' ')
      : ''
    return normalize(
      e.getAttribute('aria-label') ||
        byIds ||
        (e as HTMLElement).innerText ||
        e.getAttribute('title') ||
        e.getAttribute('alt') ||
        '',
    )
  }
  const matches = (e: Element, spec: SelectorSpec) => {
    if (typeof spec === 'string') return e.matches(spec)
    return (
      (!spec.css || e.matches(spec.css)) &&
      (!spec.role || roleOf(e) === spec.role) &&
      (spec.name === undefined || nameOf(e) === spec.name) &&
      (spec.text === undefined ||
        normalize((e as HTMLElement).innerText) === spec.text)
    )
  }
  const select = (root: ParentNode, spec: SelectorSpec) =>
    typeof spec === 'string'
      ? [...root.querySelectorAll(spec)]
      : [...root.querySelectorAll(spec.css ?? '*')].filter((e) =>
          matches(e, spec),
        )
  const closest = (element: Element, spec: SelectorSpec) => {
    for (
      let node: Element | null = element;
      node && node.nodeType === 1;
      node = node.parentElement
    )
      if (matches(node, spec)) return node
    return null
  }
  // Validate every selector now, so a CSS error surfaces before the capture starts.
  for (const spec of [...validate, ...actions.map((action) => action.selector)])
    select(document, spec)
  const buffer: RecordedAction[] = []
  let polledAt = Date.now()
  // A click on a label makes the browser click its control too, in the same task.
  // Actions the label click recorded are not recorded again for that second click.
  let forwarded: { control: Element; actions: Set<string> } | undefined
  /** Records the actions a click matched, except `repeated` ones; returns them all. */
  const record = (
    event: MouseEvent,
    target: Element,
    repeated: Set<string>,
  ) => {
    const matched = new Set<string>()
    for (const action of actions) {
      if (!closest(target, action.selector)) continue
      matched.add(action.name)
      if (repeated.has(action.name)) continue
      buffer.push({
        name: action.name,
        at: Date.now(),
        trusted: event.isTrusted,
      })
      if (buffer.length > 500) buffer.shift()
    }
    return matched
  }
  const forwardFromLabel = (target: Element, matched: Set<string>) => {
    const control = target.closest('label')?.control
    if (!matched.size || !control || control.contains(target)) return
    const current = { control, actions: matched }
    forwarded = current
    setTimeout(() => {
      if (forwarded === current) forwarded = undefined
    })
  }
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const repeated =
      forwarded?.control === target ? forwarded.actions : new Set<string>()
    forwarded = undefined
    forwardFromLabel(target, record(event, target, repeated))
  }
  if (actions.length) document.addEventListener('click', onClick, true)
  Object.defineProperty(globalThis, '__recoveryProbeObserve', {
    configurable: true,
    value: Object.freeze({
      token,
      select,
      normalize,
      imagesIn,
      lastPolledAt: () => polledAt,
      drainActions: () => {
        polledAt = Date.now()
        return buffer.splice(0)
      },
      stop: () => document.removeEventListener('click', onClick, true),
    }),
  })
  return true
}

// Runs in the page.
export function removeObserverKit(token: string): boolean {
  const kit = globalThis.__recoveryProbeObserve
  if (!kit || kit.token !== token) return false
  kit.stop()
  delete globalThis.__recoveryProbeObserve
  return true
}
