import type { ProbeWebContents } from './types.cjs'

/** A developer's classifier; whatever it returns is checked before it becomes a label. */
export type LabelFunction = (channel: string, args: unknown[]) => unknown

export interface InstallOptions {
  channels: string[]
  sender: () => ProbeWebContents | undefined | null
  classify?: LabelFunction
  pushChannels: string[]
  classifyPush?: LabelFunction
}

export type IpcFault = 'rejection' | 'null-result'

export interface Plan {
  id: string
  channel: string
  /** The target channel and its dependencies, once each. */
  watched: string[]
  fault: IpcFault | undefined
  observation: boolean
  times: number
  ttlMs: number
  delayMs: number
  skip: number
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const isIntegerIn = (value: unknown, low: number, high: number) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= low &&
  value <= high

const isNameList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((name) => typeof name === 'string' && name.trim() !== '') &&
  new Set(value).size === value.length

/** The install options, checked in the order the errors are documented. */
export function checkInstall(
  ipcMain: { handle?: unknown } | null | undefined,
  options: Record<string, unknown> | undefined,
): InstallOptions {
  const {
    channels,
    sender,
    enabled = false,
    classify,
    pushChannels = [],
    classifyPush,
  } = options === undefined ? {} : options
  ensure(
    enabled === true,
    'IPC probe requires explicit development-only enablement',
  )
  ensure(
    isNameList(channels) && channels.length > 0,
    'Provide unique, explicitly allowed read channels',
  )
  ensure(
    typeof sender === 'function' && typeof ipcMain?.handle === 'function',
    'Provide ipcMain and a sender function returning the target WebContents',
  )
  ensure(
    classify === undefined || typeof classify === 'function',
    'classify must be a function returning a method label',
  )
  ensure(
    classifyPush === undefined || typeof classifyPush === 'function',
    'classifyPush must be a function returning an event label',
  )
  ensure(isNameList(pushChannels), 'pushChannels must be unique channel names')
  return {
    channels,
    sender,
    classify,
    pushChannels,
    classifyPush,
  } as InstallOptions
}

/** A plan's options with their defaults, read in the order `begin` documents them. */
export const withPlanDefaults = ({
  id,
  channel,
  requiredChannels = [],
  fault,
  observation = false,
  times = 1,
  ttlMs = 30000,
  delayMs = 0,
  skip = 0,
}: Record<string, unknown>) => ({
  id,
  channel,
  requiredChannels,
  fault,
  observation,
  times,
  ttlMs,
  delayMs,
  skip,
})

type Requested = ReturnType<typeof withPlanDefaults>

interface Known {
  seenIds: Set<string>
  allowed: Set<string>
  registered: Set<string>
}

/** Checks a plan's run ID and channels, then its fault and timing. */
export function checkPlan(requested: Requested, known: Known): Plan {
  const watched = checkRun(requested, known)
  checkFault(requested)
  return { ...requested, watched } as unknown as Plan
}

function checkRun(
  { id, channel, requiredChannels }: Requested,
  { seenIds, allowed, registered }: Known,
) {
  ensure(
    typeof id === 'string' && id && id.length <= 100 && !seenIds.has(id),
    'Use a new non-empty run ID',
  )
  ensure(seenIds.size < 10000, 'Restart the dev app after 10000 probe runs')
  ensure(Array.isArray(requiredChannels), 'requiredChannels must be an array')
  const watched = [...new Set([channel, ...requiredChannels])] as string[]
  ensure(
    watched.every((name) => allowed.has(name) && registered.has(name)),
    'All watched channels must be allowed and registered after installing the probe',
  )
  return watched
}

function checkFault({
  fault,
  observation,
  times,
  ttlMs,
  delayMs,
  skip,
}: Requested) {
  const faulted = fault !== undefined
  ensure(
    !faulted || ['rejection', 'null-result'].includes(fault as string),
    'Supported IPC faults: rejection, null-result',
  )
  ensure(
    typeof observation === 'boolean' && !(observation && faulted),
    'Observation must be fault-free',
  )
  ensure(isIntegerIn(times, 1, 10), 'times must be 1–10')
  ensure(
    isIntegerIn(delayMs, 0, 10000) && (faulted || delayMs === 0),
    'delayMs must be 0–10000 and needs a fault',
  )
  ensure(
    isIntegerIn(skip, 0, 9) && (faulted || skip === 0),
    'skip must be 0–9 and needs a fault',
  )
  ensure(
    isIntegerIn(ttlMs, 100, observation ? 125000 : 60000),
    'ttlMs exceeds the supported bounds',
  )
}
