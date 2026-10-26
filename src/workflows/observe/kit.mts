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

export interface ObserverKit {
  token: string
  select(root: ParentNode, spec: SelectorSpec): Element[]
  normalize(value: unknown): string
  lastPolledAt(): number
  drainActions(): RecordedAction[]
  stop(): void
}

declare global {
  // The in-page kit for the capture that owns this page.
  var __recoveryProbeObserve: ObserverKit | undefined
}

// Runs in the page. Self-contained: page.evaluate serializes this function.
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
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const repeated =
      forwarded?.control === target ? forwarded.actions : new Set<string>()
    forwarded = undefined
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
    const control = target.closest('label')?.control
    if (matched.size && control && !control.contains(target)) {
      const current = { control, actions: matched }
      forwarded = current
      setTimeout(() => {
        if (forwarded === current) forwarded = undefined
      })
    }
  }
  if (actions.length) document.addEventListener('click', onClick, true)
  Object.defineProperty(globalThis, '__recoveryProbeObserve', {
    configurable: true,
    value: Object.freeze({
      token,
      select,
      normalize,
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
