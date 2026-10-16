import type { Page } from 'playwright'
import {
  observationMetadata,
  samplingMetrics,
  observationSummary,
  contentComparisons,
  actionEffects,
  type ContentBeforeReadFinding,
  type DelayedUiUpdateFinding,
  type ObservationInterval,
  type ObservationMetadata,
  type ObservationOperator,
  type ObservationReport,
  type ObservedAction,
  type ReadCounts,
  type RowTransition,
  type SummarizedRows,
  type TimelineEvent,
  type TrackedRow,
} from './observation-report.mjs'
import { performance } from 'node:perf_hooks'
import { randomUUID, createHash } from 'node:crypto'
import {
  readRegion,
  summarizeRegion,
  type ObservationReadInput,
  type RegionRead,
} from './ipc-observation.mjs'
import { observeHttp } from './http-observer.mjs'
import {
  selectorSpec,
  installObserverKit,
  removeObserverKit,
  type ObservedActionConfig,
  type SelectorSpec,
} from './observation-kit.mjs'
import type { IpcInspector } from './ipc-inspector.mjs'
import type { IpcPushStats, IpcReadStats } from './ipc-probe.cjs'

const LABEL = /^[\w.:/-]{1,100}$/
const NAME = /^[\w.-]{1,40}$/

export interface RowsConfig {
  selector: SelectorSpec
  key?: SelectorSpec
  state: SelectorSpec
  states: string[]
  aliases: Record<string, string>
}

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
  lagThresholdMs: number
  minUnchangedReads: number
  detail: 'content' | 'region'
  observationMs: number
  sampleMs: number
}

type ReadRow = IpcReadStats & { methods?: Record<string, IpcReadStats> }

/** Read counters from the HTTP observer or the IPC development hook. */
export interface ReadSnapshot {
  startedAt: number
  capturedAt: number
  channels: Record<string, ReadRow>
  pushes?: Record<
    string,
    IpcPushStats & { methods?: Record<string, IpcPushStats> }
  >
}

export interface ObservationAdapter {
  start(): Promise<void>
  snapshot(): ReadSnapshot | Promise<ReadSnapshot>
  stop(): Promise<Record<string, unknown> | undefined>
  metadata?(): ObservationMetadata['ipcHook']
}

export function observationConfig(input: unknown): ObservationConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Observation config must be an object')
  const c: Record<string, unknown> = {
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
    lagThresholdMs: 2000,
    minUnchangedReads: 2,
    detail: 'content',
    observationMs: 30000,
    sampleMs: 100,
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(c, key))
      throw Error(`Unsupported observation option: ${key}`)
    c[key] = (input as Record<string, unknown>)[key]
  }
  if (!['http', 'ipc'].includes(c.transport as string))
    throw Error('transport must be http or ipc')
  if (!['content', 'region'].includes(c.detail as string))
    throw Error('detail must be content or region')
  if (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())
    throw Error('regionSelector must be an explicit CSS selector')
  c.contentSelector = selectorSpec(c.contentSelector, 'contentSelector')
  for (const [key, low, high] of [
    ['observationMs', 500, 120000],
    ['sampleMs', 50, 1000],
    ['lagThresholdMs', 500, 60000],
    ['minUnchangedReads', 1, 20],
  ] as const) {
    const value = c[key]
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < low ||
      value > high
    )
      throw Error(`${key} must be ${low}–${high}`)
  }
  if (
    c.page !== undefined &&
    (typeof c.page !== 'number' || !Number.isInteger(c.page) || c.page < 0)
  )
    throw Error('page must be a non-negative integer')
  for (const key of ['cdp', 'inspector']) {
    const url = new URL(c[key] as string)
    if (
      !['http:', 'ws:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw Error(
        `${key} must be a loopback HTTP or WebSocket address without credentials`,
      )
  }
  if (c.rows !== undefined) c.rows = rowsConfig(c.rows)
  if (c.actions !== undefined) {
    if (!Array.isArray(c.actions) || !c.actions.length || c.actions.length > 20)
      throw Error('actions must list 1–20 { name, selector } entries')
    const actions: ObservedActionConfig[] = c.actions.map((a, i) => {
      if (
        !a ||
        typeof a !== 'object' ||
        Object.keys(a).some((k) => !['name', 'selector'].includes(k))
      )
        throw Error(`actions[${i}] must be { name, selector }`)
      if (typeof a.name !== 'string' || !NAME.test(a.name))
        throw Error(`actions[${i}].name must match ${NAME}`)
      return {
        name: a.name,
        selector: selectorSpec(a.selector, `actions[${i}].selector`),
      }
    })
    c.actions = actions
    if (new Set(actions.map((a) => a.name)).size !== actions.length)
      throw Error('action names must be unique')
  }
  if (c.transport === 'http') {
    const url = new URL(c.endpoint as string)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error(
        'endpoint must be HTTP(S) origin/path without credentials, query or fragment',
      )
    c.endpoint = url.href
    if (
      c.channel !== undefined ||
      c.methods !== undefined ||
      c.dataEvents !== undefined
    )
      throw Error('channel, methods and dataEvents are only supported with IPC')
  } else {
    if (typeof c.channel !== 'string' || !c.channel.trim())
      throw Error('channel is required')
    if (
      c.endpoint !== undefined ||
      c.page !== undefined ||
      c.pageUrl !== undefined
    )
      throw Error('IPC selects the window owned by its development hook')
    if (c.methods !== undefined) c.methods = labels(c.methods, 'methods')
    if (c.dataEvents !== undefined) {
      const d = c.dataEvents
      if (
        !d ||
        typeof d !== 'object' ||
        Object.keys(d).some((k) => !['channel', 'methods'].includes(k))
      )
        throw Error('dataEvents must be { channel, methods? }')
      const events = d as { channel?: unknown; methods?: unknown }
      if (typeof events.channel !== 'string' || !events.channel.trim())
        throw Error('dataEvents must be { channel, methods? }')
      c.dataEvents = {
        channel: events.channel,
        ...(events.methods === undefined
          ? {}
          : { methods: labels(events.methods, 'dataEvents.methods') }),
      }
    }
  }
  return c as unknown as ObservationConfig
}

function labels(value: unknown, key: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 50 ||
    value.some((v) => typeof v !== 'string' || !LABEL.test(v)) ||
    new Set(value).size !== value.length
  )
    throw Error(`${key} must list 1–50 unique labels matching ${LABEL}`)
  return [...value]
}

function rowsConfig(input: unknown): RowsConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('rows must be { selector, key?, state, states, aliases? }')
  const r = input as Record<string, unknown>
  for (const k of Object.keys(r))
    if (!['selector', 'key', 'state', 'states', 'aliases'].includes(k))
      throw Error(`Unsupported rows property: ${k}`)
  const states = r.states
  if (
    !Array.isArray(states) ||
    !states.length ||
    states.length > 20 ||
    states.some((s) => typeof s !== 'string' || !s.trim() || s.length > 60) ||
    new Set(states).size !== states.length
  )
    throw Error(
      'rows.states must list 1–20 unique visible state labels (1–60 characters)',
    )
  const aliases = r.aliases ?? {}
  if (
    typeof aliases !== 'object' ||
    Array.isArray(aliases) ||
    Object.keys(aliases).length > 20
  )
    throw Error('rows.aliases must map up to 20 alias names to row key text')
  for (const [alias, text] of Object.entries(aliases))
    if (
      !NAME.test(alias) ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 200
    )
      throw Error(
        `rows.aliases.${alias} must map a name matching ${NAME} to 1–200 characters of key text`,
      )
  return {
    selector: selectorSpec(r.selector, 'rows.selector'),
    ...(r.key === undefined ? {} : { key: selectorSpec(r.key, 'rows.key') }),
    state: selectorSpec(r.state, 'rows.state'),
    states: [...states],
    aliases: { ...(aliases as Record<string, string>) },
  }
}

const zero: IpcReadStats = {
  calls: 0,
  successes: 0,
  errors: 0,
  pending: 0,
  firstReadAt: null,
  lastReadAt: null,
  firstCompletedAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
}
// The selected read: a whole channel/endpoint, or only the configured method labels on a shared channel.
function selectedReads(
  snapshot: ReadSnapshot,
  c: ObservationConfig,
): IpcReadStats | undefined {
  const row =
    snapshot.channels[(c.transport === 'ipc' ? c.channel : c.endpoint)!]
  if (!c.methods || !row) return row
  const total = { ...zero }
  for (const name of c.methods) {
    const m = row.methods?.[name]
    if (!m) continue
    for (const k of ['calls', 'successes', 'errors', 'pending'] as const)
      total[k] += m[k]
    for (const k of ['lastReadAt', 'lastCompletedAt', 'lastSuccessAt'] as const)
      total[k] = Math.max(total[k] ?? 0, m[k] ?? 0) || null
    for (const k of ['firstReadAt', 'firstCompletedAt'] as const)
      total[k] = m[k] === null ? total[k] : Math.min(total[k] ?? Infinity, m[k])
  }
  return total
}
function dataEvents(
  snapshot: ReadSnapshot,
  c: ObservationConfig,
): { count: number; lastAt: number | null } | null {
  if (!c.dataEvents) return null
  const p = snapshot.pushes?.[c.dataEvents.channel]
  if (!p) return { count: 0, lastAt: null }
  if (!c.dataEvents.methods) return { count: p.count, lastAt: p.lastAt }
  let count = 0,
    lastAt: number | null = null
  for (const name of c.dataEvents.methods) {
    const m = p.methods?.[name]
    if (m) {
      count += m.count
      lastAt = Math.max(lastAt ?? 0, m.lastAt ?? 0) || lastAt
    }
  }
  return { count, lastAt }
}

export function ipcObservationAdapter(
  control: IpcInspector,
  config: ObservationConfig,
  senderId: number,
): ObservationAdapter {
  let id: string | undefined,
    metadata: ObservationMetadata['ipcHook'] = null
  return {
    metadata: () => metadata,
    async start() {
      const identity = await control.call('identify')
      if (
        !identity.capabilities?.observation ||
        !identity.capabilities?.readTimestamps
      )
        throw Error(
          'IPC_OBSERVATION_UNSUPPORTED: restart the development app with the new observation-capable hook',
        )
      if (config.methods && !identity.capabilities.methods)
        throw Error(
          'IPC_METHODS_UNSUPPORTED: configure a classify function in the development hook',
        )
      if (
        config.dataEvents &&
        (!identity.capabilities.pushes ||
          !identity.pushChannels?.includes(config.dataEvents.channel))
      )
        throw Error(
          'IPC_PUSHES_UNSUPPORTED: list dataEvents.channel in the development hook pushChannels',
        )
      metadata = {
        version: identity.version ?? null,
        runtime: {
          node: identity.runtime?.node ?? null,
          electron: identity.runtime?.electron ?? null,
          chrome: identity.runtime?.chrome ?? null,
        },
        capabilities: {
          observation: identity.capabilities.observation,
          readTimestamps: identity.capabilities.readTimestamps,
          maxFaultCount: identity.capabilities.maxFaultCount ?? null,
          methods: identity.capabilities.methods ?? false,
          pushes: identity.capabilities.pushes ?? false,
        },
      }
      if (identity.senderId !== senderId) throw Error('IPC_TARGET_CHANGED')
      const previous = await control.call('snapshot')
      if (previous?.armed || previous?.observingUntil)
        throw Error('IPC_PLAN_ALREADY_ACTIVE')
      id = randomUUID() // A lost begin reply still requires scoped cleanup.
      await control.call('begin', {
        id,
        channel: config.channel!,
        observation: true,
        ttlMs: config.observationMs + 5000,
      })
    },
    async snapshot() {
      const s = await control.call('snapshot')
      if (
        !s ||
        s.id !== id ||
        s.senderId !== senderId ||
        !s.observation ||
        !s.observingUntil ||
        s.armed ||
        s.injected
      )
        throw Error('IPC_OBSERVATION_COVERAGE_LOST')
      return s
    },
    async stop() {
      if (!id) return
      // reset(id) cannot clear another client's plan, even after an uncertain reply.
      let resetError: Error | undefined
      try {
        await control.call('reset', id)
      } catch (error) {
        resetError = error as Error
      }
      const s = await control.call('snapshot')
      if (!s || s.id !== id || s.observingUntil || s.armed || s.injected !== 0)
        throw Error(
          `IPC_OBSERVATION_CLEANUP_UNVERIFIED${resetError ? ': ' + resetError.message : ''}`,
        )
      return {
        transport: 'ipc',
        verified: true,
        runId: s.id,
        capturedAt: s.capturedAt,
        observingUntil: s.observingUntil,
        armed: s.armed,
        injected: s.injected,
      }
    },
  }
}

export function httpObservationAdapter(
  page: Page,
  config: ObservationConfig,
): ObservationAdapter {
  let observer: Awaited<ReturnType<typeof observeHttp>> | undefined
  return {
    async start() {
      observer = await observeHttp(page, { endpoint: config.endpoint! })
    },
    snapshot() {
      return observer!.snapshot()
    },
    async stop() {
      await observer?.stop()
      return { transport: 'http', listenersDetached: true }
    },
  }
}

const counts = (row: IpcReadStats): ReadCounts => ({
  calls: row.calls,
  successes: row.successes,
  errors: row.errors,
  pending: row.pending,
})
const delta = (row: IpcReadStats, base: ReadCounts) => ({
  calls: row.calls - base.calls,
  successes: row.successes - base.successes,
  errors: row.errors - base.errors,
  pending: row.pending,
  pendingAtStart: base.pending,
})
const age = (snapshot: ReadSnapshot, at: number | null) =>
  at === null ? null : Math.max(0, snapshot.capturedAt - at)
const completedOf = (row: ReadCounts) => row.successes + row.errors
const rowKeyHash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

// Row keys are hashed; only allowlisted state labels and configured aliases are kept.
export function summarizeRows(
  raw: RegionRead['rows'],
  r: RowsConfig,
): SummarizedRows | null {
  if (!raw) return null
  const aliasOf = new Map(
    Object.entries(r.aliases).map(([alias, text]): [string, string] => [
      text.replace(/\s+/g, ' ').trim(),
      alias,
    ]),
  )
  const seen = new Map<string, number>()
  const items = raw.items.map(({ key, state }) => {
    let id = aliasOf.get(key) ?? `key:${rowKeyHash(key)}`
    const n = (seen.get(id) ?? 0) + 1
    seen.set(id, n)
    if (n > 1) id += `#${n}`
    return {
      row: id,
      state:
        state === null ? 'none' : r.states.includes(state) ? state : 'other',
    }
  })
  return { truncated: raw.truncated, items }
}

/** One sample as the row tracker sees it. */
export interface RowSample {
  index: number
  interval: number
  fromMs: number
  toMs: number
  rows: SummarizedRows | null
  completed: number
  data: { count: number; lastAtMs: number | null } | null
}

/**
 * Tracks allowlisted row states across samples. A state that survived several completed
 * selected reads and then changed with no data event to explain it is reported as
 * DELAYED_UI_UPDATE: an observation that needs review, not a defect verdict.
 */
export function rowTracker(c: ObservationConfig) {
  const rows = new Map<
    string,
    {
      row: string
      firstSeen: TrackedRow['firstSeen']
      transitions: RowTransition[]
      current: { state: string; first: RowSample; last: RowSample }
    }
  >()
  const findings: DelayedUiUpdateFinding[] = [],
    actions: ObservedAction[] = []
  const tracked = (state: string) => c.rows!.states.includes(state)
  const lastActionBefore = (ms: number) =>
    actions.filter((a) => a.atMs <= ms).at(-1) ?? null
  return {
    addActions(list: ObservedAction[]) {
      actions.push(...list)
    },
    add(s: RowSample) {
      for (const { row, state } of s.rows?.items ?? []) {
        const entry = rows.get(row)
        if (!entry) {
          const action = lastActionBefore(s.toMs)
          rows.set(row, {
            row,
            firstSeen: {
              interval: s.interval,
              fromMs: s.fromMs,
              toMs: s.toMs,
              state,
              afterAction: action && { name: action.name, atMs: action.atMs },
            },
            transitions: [],
            current: { state, first: s, last: s },
          })
          continue
        }
        const { first, last } = entry.current
        if (entry.current.state === state) {
          entry.current.last = s
          continue
        }
        const transition: RowTransition = {
          from: entry.current.state,
          to: state,
          interval: s.interval,
          afterMs: last.toMs,
          byMs: s.toMs,
        }
        const action = lastActionBefore(s.toMs)
        if (action)
          transition.afterAction = { name: action.name, atMs: action.atMs }
        entry.transitions.push(transition)
        // Evaluate only consecutive observations of a visible row with both states allowlisted.
        if (
          last.index === s.index - 1 &&
          tracked(transition.from) &&
          tracked(state)
        ) {
          const unchangedReads = last.completed - first.completed
          const persistedMs = last.toMs - first.fromMs
          const noDataInWindow =
            s.data === null || s.data.count === last.data!.count
          const sinceDataMs =
            s.data?.lastAtMs == null
              ? null
              : transition.afterMs - s.data.lastAtMs
          const dataQuiet =
            s.data === null ||
            sinceDataMs === null ||
            sinceDataMs >= c.lagThresholdMs
          if (
            persistedMs >= c.lagThresholdMs &&
            unchangedReads >= c.minUnchangedReads &&
            noDataInWindow &&
            dataQuiet
          ) {
            // A stale state that began right after a user action (for example an optimistic label) is the strongest lead.
            const stateAction = lastActionBefore(first.toMs)
            const startedAfterActionMs =
              stateAction && first.fromMs - stateAction.atMs <= c.lagThresholdMs
                ? Math.max(0, first.fromMs - stateAction.atMs)
                : null
            const finding: DelayedUiUpdateFinding = {
              code: 'DELAYED_UI_UPDATE',
              kind: 'observation',
              confidence:
                s.data && startedAfterActionMs !== null ? 'medium' : 'low',
              basis: s.data
                ? 'NO_DATA_EVENT_BEFORE_UI_CHANGE'
                : 'UNCHANGED_ACROSS_READS',
              interval: s.interval,
              row,
              from: transition.from,
              to: state,
              changedAfterMs: transition.afterMs,
              changedByMs: transition.byMs,
              previousStateSinceMs: first.fromMs,
              previousStateStartedAfterActionMs: startedAfterActionMs,
              persistedMs,
              unchangedReadCompletions: unchangedReads,
              dataEventsWhilePersisted: s.data
                ? last.data!.count - first.data!.count
                : null,
              sinceLastDataEventMs: sinceDataMs,
              afterAction: transition.afterAction
                ? {
                    ...transition.afterAction,
                    changedAfterActionMs: [
                      transition.afterMs - transition.afterAction.atMs,
                      transition.byMs - transition.afterAction.atMs,
                    ],
                  }
                : null,
              note: 'Row state persisted across completed selected reads and then changed without a data event in the sampled window. Read contents are not recorded, so this needs review against the application logic; it is not a defect verdict.',
            }
            finding.summary = observationSummary(finding)
            findings.push(finding)
          }
        }
        entry.current = { state, first: s, last: s }
      }
    },
    snapshot(): { rows: TrackedRow[]; findings: DelayedUiUpdateFinding[] } {
      return {
        rows: [...rows.values()].map(
          ({ row, firstSeen, transitions, current }) => ({
            row,
            firstSeen,
            transitions,
            lastState: current.state,
          }),
        ),
        findings,
      }
    },
  }
}

async function boundedUiRead<T>(
  action: () => T | Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined,
    cancel: (() => void) | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw Error('CAPTURE_INTERRUPTED')
        return action()
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                `UI_SAMPLE_TIMEOUT: renderer did not respond within ${timeoutMs} ms`,
              ),
            ),
          timeoutMs,
        )
        cancel = () => reject(Error('CAPTURE_INTERRUPTED'))
        signal?.addEventListener('abort', cancel, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
}

export interface ObservationHooks {
  signal?: AbortSignal
  /** Returns true to open a new operator interval. */
  takeMarker?: () => boolean
  onReady?: () => unknown
  onInterval?: (index: number) => unknown
  onSample?: (event: TimelineEvent) => unknown
  operator?: (context: {
    mark: () => Promise<number | null>
    signal: AbortSignal
    elapsed: () => number
  }) => unknown
}

type CaptureReport = ObservationReport &
  Required<
    Pick<
      ObservationReport,
      'metadata' | 'comparisons' | 'timeline' | 'notes' | 'coverage'
    >
  >

/**
 * Observe only. No reload, navigation, routing, focus changes or final UI reset.
 * An optional `operator` function may act on the app (for example explicit --steps); it
 * receives `mark()` to open a new interval and its outcome is reported separately.
 */
export async function runObservation(
  page: Page,
  input: unknown,
  adapter: ObservationAdapter,
  {
    signal,
    takeMarker = () => false,
    onReady = () => {},
    onInterval = () => {},
    onSample = () => {},
    operator,
  }: ObservationHooks = {},
): Promise<ObservationReport> {
  const c = observationConfig(input)
  const target = (c.transport === 'ipc' ? c.channel : c.endpoint)!
  const metrics = samplingMetrics(c.sampleMs)
  const comparisons = contentComparisons()
  const tracker = c.rows ? rowTracker(c) : null
  const report: CaptureReport = {
    schemaVersion: 1,
    metadata: observationMetadata(),
    mode: 'fault-free observation',
    transport: c.transport,
    target,
    ...(c.methods ? { targetMethods: c.methods } : {}),
    generatedAt: new Date().toISOString(),
    status: 'incomplete',
    captureComplete: false,
    observationMs: c.observationMs,
    sampleMs: c.sampleMs,
    detail: c.detail,
    intervals: [],
    findings: [],
    comparisons: [],
    timeline: [],
    ...(c.actions ? { actions: [] } : {}),
    notes: [],
    injected: 0,
    reloads: 0,
    cleanup: 'not-started',
    coverage: {
      historyBeforeCapture: 'unknown',
      pendingBeforeCapture: 'unknown',
      scope:
        'One selected renderer and read target; only calls starting during capture are counted.',
      gaps: [],
    },
    limitation:
      'Observations are not recovery passes or account-isolation verdicts. Cache reuse may be legitimate. Intervals start at capture or an operator marker, not at a proven mount or identity change. HTTP success means a completed 2xx response, not valid JSON or UI correctness. UI changes between samples can be missed. Only hashes, structural counts, allowlisted row states, configured action names and read metadata are stored; hashes are not anonymization.',
  }
  // Opened before the sampling loop; finally only closes it if it was opened.
  let interval!: ObservationInterval
  let lastSnapshot: ReadSnapshot | undefined,
    started: number | undefined,
    startedEpoch: number | undefined,
    previousSignature: string | undefined,
    samples = 0,
    kitToken: string | undefined
  let attempted = false,
    pageErrors = 0,
    newDocument = false,
    operatorRun: Promise<ObservationOperator> | undefined
  const markerRequests: { resolve?: (index: number | null) => void }[] = []
  const operatorAbort = new AbortController()
  const errors = () => {
    pageErrors++
  }
  // A document load destroys the state being investigated. SPA route changes are allowed.
  const documentLoaded = () => {
    newDocument = true
  }
  const elapsed = () => Math.round(performance.now() - started!)
  const channelRow = (s: ReadSnapshot) => s.channels[target]
  const openInterval = (s: ReadSnapshot) => {
    const row = selectedReads(s, c)
    interval = {
      index: report.intervals.length + 1,
      startMs: elapsed(),
      startCounts: counts(row!),
      firstContent: null,
      samples: 0,
      findings: [],
      ...(c.methods ? { startChannelCounts: counts(channelRow(s)) } : {}),
      ...(c.dataEvents ? { startDataEvents: dataEvents(s, c)!.count } : {}),
    }
    report.intervals.push(interval)
    previousSignature = undefined
  }
  const closeInterval = () => {
    if (!interval || !lastSnapshot) return
    interval.endMs = elapsed()
    interval.reads = delta(
      selectedReads(lastSnapshot, c)!,
      interval.startCounts!,
    )
    if (c.methods)
      interval.channelReads = delta(
        channelRow(lastSnapshot),
        interval.startChannelCounts!,
      )
    if (c.dataEvents)
      interval.dataEvents =
        dataEvents(lastSnapshot, c)!.count - interval.startDataEvents!
    delete interval.startChannelCounts
    delete interval.startDataEvents
  }
  const gap = (code: string) => {
    if (!report.coverage.gaps.includes(code)) report.coverage.gaps.push(code)
  }
  const takeAnyMarker = () => {
    if (markerRequests.length) return markerRequests.shift()
    return takeMarker() ? {} : null
  }
  try {
    kitToken = randomUUID()
    const readInput: ObservationReadInput = {
      regionSelector: c.regionSelector,
      contentSelector: c.contentSelector,
      detail: c.detail,
      kitToken,
      ...(c.rows
        ? {
            rows: {
              selector: c.rows.selector,
              key: c.rows.key,
              state: c.rows.state,
            },
          }
        : {}),
    }
    // One renderer call installs the kit and validates every selector without requiring the region to be mounted yet.
    const validate = [
      c.regionSelector,
      c.contentSelector,
      ...(c.rows
        ? [c.rows.selector, ...(c.rows.key ? [c.rows.key] : []), c.rows.state]
        : []),
    ]
    const token = kitToken
    await boundedUiRead(
      () =>
        page.evaluate(installObserverKit, {
          token,
          actions: c.actions ?? [],
          validate,
        }),
      signal,
    )
    page.on('pageerror', errors)
    page.on('domcontentloaded', documentLoaded)
    attempted = true
    await adapter.start()
    report.metadata.ipcHook = adapter.metadata?.() ?? null
    started = performance.now()
    startedEpoch = Date.now()
    lastSnapshot = await adapter.snapshot()
    report.startedAt = lastSnapshot.startedAt
    openInterval(lastSnapshot)
    await onReady()
    if (operator) {
      const mark = () =>
        new Promise<number | null>((resolve) =>
          markerRequests.push({ resolve }),
        )
      operatorRun = Promise.resolve()
        .then(() => operator({ mark, signal: operatorAbort.signal, elapsed }))
        .then(
          (steps): ObservationOperator => ({
            status: 'complete',
            ...(Array.isArray(steps) ? { steps } : {}),
          }),
          (error): ObservationOperator => ({
            status: operatorAbort.signal.aborted ? 'stopped' : 'failed',
            error: error.message,
            ...(Array.isArray(error.results) ? { steps: error.results } : {}),
          }),
        )
    }
    while (true) {
      if (signal?.aborted) {
        report.status = 'interrupted'
        break
      }
      if (newDocument)
        throw Error(
          'DOCUMENT_REPLACED: capture stopped; the in-memory state may have been reset',
        )
      const marker = takeAnyMarker()
      if (marker) {
        if (report.intervals.length >= 50) throw Error('INTERVAL_LIMIT_REACHED')
        // Use a fresh boundary snapshot; do not attribute between-sample reads to the next interval.
        lastSnapshot = await adapter.snapshot()
        closeInterval()
        openInterval(lastSnapshot)
        await onInterval(interval.index)
        marker.resolve?.(interval.index)
      }
      const beforeStart = performance.now()
      const before = await adapter.snapshot()
      const uiStart = performance.now()
      const sampleStart = elapsed()
      const {
        rendererReadMs,
        rows: rawRows,
        actions: rawActions,
        ...raw
      } = await boundedUiRead(
        () => page.evaluate(readRegion, readInput),
        signal,
      )
      const summarizeStart = performance.now()
      // A read without text or content (an absent or hidden region) summarizes to itself.
      const ui = summarizeRegion(raw)
      const rows = c.rows ? summarizeRows(rawRows, c.rows) : null
      const afterStart = performance.now()
      const after = await adapter.snapshot()
      const afterEnd = performance.now()
      if (newDocument)
        throw Error(
          'DOCUMENT_REPLACED: capture stopped; the in-memory state may have been reset',
        )
      lastSnapshot = after
      const row = selectedReads(after, c)
      if (!row || !Object.hasOwn(row, 'lastCompletedAt'))
        throw Error('READ_TIMESTAMPS_UNAVAILABLE')
      if (!ui.visible) gap('HIDDEN_DOCUMENT')
      if (ui.truncated) gap('TRUNCATED_REGION')
      if (rows?.truncated) gap('TRUNCATED_ROWS')
      const readCounts = delta(row, interval.startCounts!)
      const data = dataEvents(after, c)
      const event: TimelineEvent = {
        interval: interval.index,
        fromMs: sampleStart,
        toMs: elapsed(),
        ui,
        ...(rows ? { rows } : {}),
        reads: readCounts,
        before: counts(selectedReads(before, c)!),
        after: counts(row),
        lastReadAgeMs: age(after, row.lastReadAt),
        lastCompletionAgeMs: age(after, row.lastCompletedAt),
        ...(data
          ? {
              dataEvents: data.count - interval.startDataEvents!,
              lastDataEventAgeMs: age(after, data.lastAt),
            }
          : {}),
        pageErrors,
      }
      if (rawActions?.length && report.actions) {
        for (const a of rawActions) {
          const atMs = a.at - startedEpoch!
          const owner =
            [...report.intervals].reverse().find((i) => i.startMs <= atMs) ??
            report.intervals[0]
          const action: ObservedAction = {
            name: a.name,
            atMs,
            trusted: a.trusted,
            interval: owner.index,
          }
          if (report.actions.length < 200) report.actions.push(action)
          else gap('ACTION_LIMIT_REACHED')
        }
        tracker?.addActions(report.actions.slice(-rawActions.length))
      }
      tracker?.add({
        index: samples,
        interval: interval.index,
        fromMs: sampleStart,
        toMs: event.toMs,
        rows,
        completed: completedOf(row),
        data: data && {
          count: data.count,
          lastAtMs: data.lastAt === null ? null : data.lastAt - startedEpoch!,
        },
      })
      if (ui.visible && (ui.contentCount ?? 0) > 0 && !interval.firstContent) {
        interval.firstContent = {
          fromMs: sampleStart,
          toMs: event.toMs,
          alreadyPresentAtFirstSample: interval.samples === 0,
          reads: readCounts,
          lastReadAgeMs: event.lastReadAgeMs,
          lastCompletionAgeMs: event.lastCompletionAgeMs,
        }
      }
      if (
        ui.visible &&
        (ui.contentCount ?? 0) > 0 &&
        readCounts.successes + readCounts.errors === 0 &&
        !interval.findings.includes('CONTENT_BEFORE_READ')
      ) {
        const finding: ContentBeforeReadFinding = {
          code: 'CONTENT_BEFORE_READ',
          kind: 'observation',
          interval: interval.index,
          fromMs: sampleStart,
          toMs: event.toMs,
          basis:
            readCounts.calls === 0 && readCounts.pendingAtStart === 0
              ? 'NO_READ_OBSERVED_IN_INTERVAL'
              : 'NO_COMPLETION_OBSERVED_IN_INTERVAL',
          reads: readCounts,
          lastReadAgeMs: event.lastReadAgeMs,
          lastCompletionAgeMs: event.lastCompletionAgeMs,
          note: 'The configured content marker is visible. This does not establish cache origin, ownership, a mount boundary, or a defect; earlier and unobserved reads are possible.',
        }
        finding.summary = observationSummary(finding)
        interval.findings.push(finding.code)
        report.findings.push(finding)
      }
      const signature = JSON.stringify([
        interval.index,
        ui,
        rows,
        readCounts,
        event.dataEvents,
        pageErrors,
      ])
      if (signature !== previousSignature) {
        if (report.timeline.length < 1000) report.timeline.push(event)
        else gap('TIMELINE_LIMIT_REACHED')
        previousSignature = signature
      }
      for (const comparison of comparisons.add(event)) {
        if (report.comparisons.length < 1000)
          report.comparisons.push(comparison)
        else gap('COMPARISON_LIMIT_REACHED')
      }
      metrics.add(event.fromMs, event.toMs, {
        beforeSnapshotMs: uiStart - beforeStart,
        uiRoundTripMs: summarizeStart - uiStart,
        rendererReadMs,
        summarizeMs: afterStart - summarizeStart,
        afterSnapshotMs: afterEnd - afterStart,
      })
      interval.samples++
      samples++
      await onSample(event)
      if (performance.now() - started >= c.observationMs) {
        report.status = 'complete'
        break
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            c.sampleMs,
            Math.max(0, c.observationMs - (performance.now() - started!)),
          ),
        ),
      )
    }
  } catch (error) {
    report.status = signal?.aborted ? 'interrupted' : 'incomplete'
    if (!signal?.aborted) report.error = (error as Error).message
  } finally {
    operatorAbort.abort()
    for (const pending of markerRequests) pending.resolve?.(null)
    if (operatorRun) {
      let timer: ReturnType<typeof setTimeout> | undefined
      // An operator that ignores the stop signal must not hold cleanup hostage.
      const outcome = await Promise.race([
        operatorRun,
        new Promise<ObservationOperator>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: 'stopped',
                error: 'Operator did not stop within 5000 ms',
              }),
            5000,
          )
        }),
      ])
      report.operator = outcome
      clearTimeout(timer)
      if (outcome.status !== 'complete') gap('OPERATOR_STEPS_INCOMPLETE')
    }
    if (interval) closeInterval()
    report.elapsedMs = started === undefined ? 0 : elapsed()
    report.samples = samples
    report.sampling = metrics.snapshot()
    report.snapshot = lastSnapshot
    report.snapshotStage = 'before-cleanup'
    page.off('pageerror', errors)
    page.off('domcontentloaded', documentLoaded)
    // Bounded: a replaced or unresponsive document must not delay owned IPC cleanup.
    if (kitToken) {
      const token = kitToken
      try {
        await boundedUiRead(
          () => page.evaluate(removeObserverKit, token),
          undefined,
          1000,
        )
      } catch {
        /* Nothing left to remove. */
      }
    }
    if (attempted) {
      try {
        report.cleanupEvidence = (await adapter.stop()) ?? null
        report.cleanup = 'complete'
      } catch (error) {
        report.cleanup = 'unverified'
        report.cleanupError = (error as Error).message
        report.status = 'incomplete'
      }
    }
    if (tracker) {
      const t = tracker.snapshot()
      report.rows = t.rows
      report.findings.push(...t.findings)
    }
    if (report.actions) report.actionEffects = actionEffects(report)
    // Read-completion comparisons are not meaningful when many selected reads finish during every sample.
    const completions = report.intervals.reduce(
      (sum, i) => sum + (i.reads ? i.reads.successes + i.reads.errors : 0),
      0,
    )
    if (samples > 0 && completions / samples > 2) {
      const omitted = report.comparisons.filter(
        (cmp) => cmp.basis === 'READ_COMPLETION',
      ).length
      report.comparisons = report.comparisons.filter(
        (cmp) => cmp.basis !== 'READ_COMPLETION',
      )
      report.notes.push({
        code: 'READ_COMPLETION_COMPARISONS_OMITTED',
        completionsPerSample: Math.round((completions / samples) * 100) / 100,
        omitted,
        note: 'The selected target completed more than two reads per sample on average, so per-completion comparisons cannot attribute UI changes. Select specific methods to narrow the target.',
      })
    }
    if (samples > 0 && !report.intervals.some((i) => i.firstContent))
      gap('CONTENT_MARKER_NOT_OBSERVED')
    report.captureComplete =
      report.status === 'complete' && report.coverage.gaps.length === 0
  }
  return report
}
