import { FAULT_KINDS } from '../../core/faults.mjs'
import {
  ensure,
  ensureRanges,
  isNonEmptyString,
  isRecord,
  isUnique,
  overDefaults,
} from '../../core/validate.mjs'

type Transport = 'http' | 'ipc'
export type RefreshFault =
  | 'http-error'
  | 'connection-failure'
  | 'invalid-json'
  | 'rejection'
  | 'null-result'

export interface RefreshTrigger {
  type: 'dom-event'
  target: 'window'
  name: string
}

/** The validated configuration: an HTTP endpoint or an IPC channel to refresh. */
export type RefreshConfig = RefreshOptions &
  (
    | { transport: 'http'; endpoint: string; channel?: string }
    | { transport: 'ipc'; channel: string; endpoint?: string }
  )

interface RefreshOptions {
  transport: Transport
  cdp: string
  inspector: string
  page?: number
  pageUrl?: string
  requiredEndpoints: string[]
  requiredChannels: string[]
  trigger: RefreshTrigger
  fault: RefreshFault
  times: number
  repeats: number
  baselineTimeoutMs: number
  observationMs: number
  idleMs: number
  settleMs: number
  secondTrigger: boolean
  regionSelector?: string
  restoreWindow: boolean
}

// A function, so each config gets its own arrays.
const defaults = () => ({
  transport: undefined,
  cdp: 'http://127.0.0.1:9222',
  inspector: 'http://127.0.0.1:9229',
  page: undefined,
  pageUrl: undefined,
  endpoint: undefined,
  requiredEndpoints: [],
  channel: undefined,
  requiredChannels: [],
  trigger: undefined,
  fault: undefined,
  times: 1,
  repeats: 3,
  baselineTimeoutMs: 15000,
  observationMs: 15000,
  idleMs: 1000,
  settleMs: 800,
  secondTrigger: false,
  regionSelector: undefined,
  restoreWindow: false,
})

const RANGES = [
  ['times', 1, 10],
  ['repeats', 1, 3],
  ['baselineTimeoutMs', 500, 30000],
  ['observationMs', 500, 30000],
  ['idleMs', 200, 10000],
  ['settleMs', 100, 5000],
] as const

const TRIGGER_KEYS = new Set(['type', 'target', 'name'])

const isTrigger = (value: unknown) =>
  isRecord(value) &&
  value.type === 'dom-event' &&
  value.target === 'window' &&
  typeof value.name === 'string' &&
  /^[a-zA-Z][\w:.-]{0,79}$/.test(value.name) &&
  Object.keys(value).every((key) => TRIGGER_KEYS.has(key))

/** An HTTP(S) origin and path, written the way the URL parser writes it back. */
function isPlainEndpoint(value: string) {
  try {
    const u = new URL(value)
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.href === value
    )
  } catch {
    return false
  }
}

const isRead = (transport: Transport) => (value: unknown) =>
  isNonEmptyString(value) && (transport === 'ipc' || isPlainEndpoint(value))

export function refreshConfig(input: object): RefreshConfig {
  const c: Record<string, unknown> = overDefaults(input, defaults())
  ensure(
    ['http', 'ipc'].includes(c.transport as string),
    'transport must be http or ipc',
  )
  const transport = c.transport as Transport
  ensure(
    isTrigger(c.trigger),
    'Use an explicit trigger: {type: dom-event, target: window, name: online}',
  )
  ensure(
    typeof c.secondTrigger === 'boolean' &&
      typeof c.restoreWindow === 'boolean',
    'Boolean options required',
  )
  const faults: RefreshFault[] =
    transport === 'http' ? [...FAULT_KINDS] : ['rejection', 'null-result']
  c.fault ??= faults[0]
  ensure(
    faults.includes(c.fault as RefreshFault),
    'Unsupported fault for transport',
  )
  const [read, dependencies] =
    transport === 'http'
      ? [c.endpoint, c.requiredEndpoints]
      : [c.channel, c.requiredChannels]
  const valid = isRead(transport)
  ensure(
    valid(read) &&
      Array.isArray(dependencies) &&
      dependencies.every(valid) &&
      isUnique([read, ...dependencies]),
    'Provide a distinct target and known read dependencies',
  )
  ensureRanges(c, RANGES, (key) => `Invalid ${key}`)
  ensure(
    c.regionSelector === undefined || isNonEmptyString(c.regionSelector),
    'Invalid regionSelector',
  )
  return c as unknown as RefreshConfig
}
