import {
  ensure,
  ensureRanges,
  isIntegerIn,
  isNonEmptyString,
  isRecord,
  isUnique,
  withDefaults,
} from '../../core/validate.mjs'
import { selectorSpec, type SelectorSpec } from '../../core/selector.mjs'
import type { ObservedActionConfig } from './kit.mjs'
import { slowReadsConfig, type SlowReadsConfig } from './slow-reads/config.mjs'
import {
  hasOnlyKeys,
  validateHttpTarget,
  validateIpcTarget,
} from './target-config.mjs'

const NAME = /^[\w.-]{1,40}$/

export interface RowsConfig {
  selector: SelectorSpec
  key?: SelectorSpec
  /** The element whose text is the row's state; `states` allowlists that text. */
  state?: SelectorSpec
  states: string[]
  /** States shown by an element rather than text: label → selector inside the row. */
  markers?: Record<string, SelectorSpec>
  /** States this region must not show. */
  unexpected?: string[]
  aliases: Record<string, string>
}

/** Every state label a row can have besides 'none' and 'other'. */
export const stateLabels = (r: Pick<RowsConfig, 'states' | 'markers'>) => [
  ...Object.keys(r.markers ?? {}),
  ...r.states,
]

export interface ObservationConfig {
  transport: 'http' | 'ipc'
  cdp: string
  inspector: string
  page?: number
  pageUrl?: string
  channel?: string
  methods?: string[]
  dataEvents?: { channel: string; methods?: string[] }
  endpoint?: string
  regionSelector: string
  contentSelector: SelectorSpec
  rows?: RowsConfig
  actions?: ObservedActionConfig[]
  slowReads?: SlowReadsConfig
  lagThresholdMs: number
  minUnchangedReads: number
  detail: 'content' | 'region'
  observationMs: number
  sampleMs: number
}

const DEFAULTS = {
  transport: undefined,
  cdp: 'http://127.0.0.1:9222',
  inspector: 'http://127.0.0.1:9229',
  page: undefined,
  pageUrl: undefined,
  channel: undefined,
  methods: undefined,
  dataEvents: undefined,
  endpoint: undefined,
  regionSelector: undefined,
  contentSelector: undefined,
  rows: undefined,
  actions: undefined,
  slowReads: undefined,
  lagThresholdMs: 2000,
  minUnchangedReads: 2,
  detail: 'content',
  observationMs: 30000,
  sampleMs: 100,
}

const RANGES = [
  ['observationMs', 500, 600000],
  ['sampleMs', 50, 1000],
  ['lagThresholdMs', 500, 60000],
  ['minUnchangedReads', 1, 20],
] as const

export function observationConfig(input: unknown): ObservationConfig {
  const c: Record<string, unknown> = withDefaults(
    input,
    DEFAULTS,
    'Observation config must be an object',
    (key) => `Unsupported observation option: ${key}`,
  )
  ensure(
    ['http', 'ipc'].includes(c.transport as string),
    'transport must be http or ipc',
  )
  ensure(
    ['content', 'region'].includes(c.detail as string),
    'detail must be content or region',
  )
  ensure(
    isNonEmptyString(c.regionSelector),
    'regionSelector must be an explicit CSS selector',
  )
  c.contentSelector = selectorSpec(c.contentSelector, 'contentSelector')
  ensureRanges(c, RANGES)
  ensure(
    c.page === undefined || isIntegerIn(c.page, 0, Infinity),
    'page must be a non-negative integer',
  )
  for (const key of ['cdp', 'inspector'])
    ensure(
      isLoopbackDevtools(new URL(c[key] as string)),
      `${key} must be a loopback HTTP or WebSocket address without credentials`,
    )
  if (c.rows !== undefined) c.rows = rowsConfig(c.rows)
  if (c.actions !== undefined) c.actions = actionsConfig(c.actions)
  if (c.slowReads !== undefined) c.slowReads = slowReadsConfig(c.slowReads)
  if (c.transport === 'http') validateHttpTarget(c)
  else validateIpcTarget(c)
  return c as unknown as ObservationConfig
}

const isLoopbackDevtools = (url: URL) =>
  ['http:', 'ws:'].includes(url.protocol) &&
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
  !url.username &&
  !url.password

function actionsConfig(value: unknown): ObservedActionConfig[] {
  ensure(
    Array.isArray(value) && value.length > 0 && value.length <= 20,
    'actions must list 1–20 { name, selector } entries',
  )
  const actions = value.map((action, i): ObservedActionConfig => {
    ensure(
      hasOnlyKeys(action, ['name', 'selector']),
      `actions[${i}] must be { name, selector }`,
    )
    ensure(
      typeof action.name === 'string' && NAME.test(action.name),
      `actions[${i}].name must match ${NAME}`,
    )
    return {
      name: action.name,
      selector: selectorSpec(action.selector, `actions[${i}].selector`),
    }
  })
  ensure(
    isUnique(actions.map((action) => action.name)),
    'action names must be unique',
  )
  return actions
}

const ROW_KEYS = new Set([
  'selector',
  'key',
  'state',
  'states',
  'markers',
  'unexpected',
  'aliases',
])

const isStateLabel = (s: unknown) =>
  typeof s === 'string' && s.trim() !== '' && s.length <= 60

function rowsConfig(input: unknown): RowsConfig {
  ensure(
    isRecord(input),
    'rows must be { selector, key?, state?, states?, markers?, unexpected?, aliases? }',
  )
  for (const key of Object.keys(input))
    ensure(ROW_KEYS.has(key), `Unsupported rows property: ${key}`)
  ensure(
    input.state !== undefined || input.markers !== undefined,
    'rows needs state and states, markers, or both',
  )
  const states = rowStates(input)
  const markers =
    input.markers === undefined ? undefined : rowMarkers(input.markers, states)
  const unexpected =
    input.unexpected === undefined
      ? undefined
      : unexpectedStates(input.unexpected, stateLabels({ states, markers }))
  const aliases = rowAliases(input.aliases ?? {})
  return {
    selector: selectorSpec(input.selector, 'rows.selector'),
    ...(input.key === undefined
      ? {}
      : { key: selectorSpec(input.key, 'rows.key') }),
    ...(input.state === undefined
      ? {}
      : { state: selectorSpec(input.state, 'rows.state') }),
    states: [...states],
    ...(markers === undefined ? {} : { markers }),
    ...(unexpected === undefined ? {} : { unexpected }),
    aliases,
  }
}

function rowStates(r: Record<string, unknown>): string[] {
  // A validated config has states: [] without state, so it validates again unchanged.
  const states = r.states ?? []
  ensure(
    Array.isArray(states) && (r.state === undefined) === !states.length,
    'rows.state and rows.states go together',
  )
  ensure(
    states.length <= 20 && states.every(isStateLabel) && isUnique(states),
    'rows.states must list 1–20 unique visible state labels (1–60 characters)',
  )
  return states
}

function rowMarkers(
  value: unknown,
  states: string[],
): Record<string, SelectorSpec> {
  const entries = isRecord(value) ? Object.entries(value) : []
  ensure(
    entries.length > 0 &&
      entries.length <= 20 &&
      entries.every(
        ([label]) => isStateLabel(label) && !['none', 'other'].includes(label),
      ),
    'rows.markers must map 1–20 state labels (1–60 characters, not none or other) to selectors',
  )
  const markers: Record<string, SelectorSpec> = {}
  for (const [label, selector] of entries) {
    ensure(
      !states.includes(label),
      `rows.markers.${label} is also a text state`,
    )
    markers[label] = selectorSpec(selector, `rows.markers.${label}`)
  }
  return markers
}

function unexpectedStates(value: unknown, known: string[]): string[] {
  ensure(
    Array.isArray(value) &&
      value.length > 0 &&
      isUnique(value) &&
      value.every((state) => known.includes(state)),
    'rows.unexpected must list unique labels from rows.states or rows.markers',
  )
  return [...value]
}

function rowAliases(aliases: unknown): Record<string, string> {
  ensure(
    typeof aliases === 'object' &&
      !Array.isArray(aliases) &&
      Object.keys(aliases as object).length <= 20,
    'rows.aliases must map up to 20 alias names to row key text',
  )
  for (const [alias, text] of Object.entries(aliases as object))
    ensure(
      NAME.test(alias) && isNonEmptyString(text) && text.length <= 200,
      `rows.aliases.${alias} must map a name matching ${NAME} to 1–200 characters of key text`,
    )
  return { ...(aliases as Record<string, string>) }
}
