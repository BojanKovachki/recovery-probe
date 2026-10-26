import { createHash } from 'node:crypto'
import type { RegionRead } from '../../core/screen.mjs'
import {
  stateLabels,
  type ObservationConfig,
  type RowsConfig,
} from './config.mjs'
import {
  observationSummary,
  type DelayedUiUpdateFinding,
  type ObservedAction,
  type RowTransition,
  type SummarizedRows,
  type TrackedRow,
  type UnexpectedRowStateFinding,
} from './report.mjs'

const rowKeyHash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

// Row keys are hashed; only allowlisted state labels and configured aliases are kept.
export function summarizeRows(
  raw: RegionRead['rows'],
  r: Pick<RowsConfig, 'states' | 'markers' | 'aliases'>,
): SummarizedRows | null {
  if (!raw) return null
  const aliasOf = new Map(
    Object.entries(r.aliases).map(([alias, text]): [string, string] => [
      text.replace(/\s+/g, ' ').trim(),
      alias,
    ]),
  )
  const markers = Object.keys(r.markers ?? {})
  const seen = new Map<string, number>()
  const items = raw.items.map(({ key, state, marker }) => {
    let id = aliasOf.get(key) ?? `key:${rowKeyHash(key)}`
    const n = (seen.get(id) ?? 0) + 1
    seen.set(id, n)
    if (n > 1) id += `#${n}`
    // A matching marker names the state; otherwise the state element's text does.
    const label = marker === undefined ? undefined : markers[marker]
    return {
      row: id,
      state:
        label ??
        (state === null ? 'none' : r.states.includes(state) ? state : 'other'),
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

type RowFinding = DelayedUiUpdateFinding | UnexpectedRowStateFinding

interface RowEntry {
  row: string
  firstSeen: TrackedRow['firstSeen']
  transitions: RowTransition[]
  /** The state the row shows, and the first and last samples that showed it. */
  current: { state: string; first: RowSample; last: RowSample }
}

/**
 * Tracks allowlisted row states across samples. A state that survived several completed
 * selected reads and then changed with no data event to explain it is reported as
 * DELAYED_UI_UPDATE: an observation that needs review, not a defect verdict. A row
 * shown in a state configured as unexpected is reported as UNEXPECTED_ROW_STATE.
 */
export class RowTracker {
  readonly #config: ObservationConfig
  readonly #labels: string[]
  readonly #unexpected: Set<string>
  readonly #rows = new Map<string, RowEntry>()
  readonly #findings: RowFinding[] = []
  readonly #actions: ObservedAction[] = []
  /** Each row's current UNEXPECTED_ROW_STATE finding and the last sample that extended it. */
  readonly #shown = new Map<
    string,
    { finding: UnexpectedRowStateFinding; index: number }
  >()

  constructor(config: ObservationConfig) {
    this.#config = config
    this.#labels = stateLabels(config.rows!)
    this.#unexpected = new Set(config.rows!.unexpected ?? [])
  }

  addActions(list: ObservedAction[]) {
    this.#actions.push(...list)
  }

  add(s: RowSample) {
    for (const { row, state } of s.rows?.items ?? []) {
      this.#showUnexpected(row, state, s)
      const entry = this.#rows.get(row)
      if (!entry) this.#rows.set(row, this.#firstSighting(row, state, s))
      else if (entry.current.state === state) entry.current.last = s
      else this.#change(entry, state, s)
    }
  }

  snapshot(): { rows: TrackedRow[]; findings: RowFinding[] } {
    // These findings grow while the row keeps the state, so their summaries are written last.
    for (const finding of this.#findings)
      if (finding.code === 'UNEXPECTED_ROW_STATE')
        finding.summary = observationSummary(finding)
    return {
      rows: [...this.#rows.values()].map(
        ({ row, firstSeen, transitions, current }) => ({
          row,
          firstSeen,
          transitions,
          lastState: current.state,
        }),
      ),
      findings: this.#findings,
    }
  }

  #lastActionBefore(ms: number) {
    return this.#actions.filter((a) => a.atMs <= ms).at(-1) ?? null
  }

  #firstSighting(row: string, state: string, s: RowSample): RowEntry {
    const action = this.#lastActionBefore(s.toMs)
    return {
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
    }
  }

  #change(entry: RowEntry, state: string, s: RowSample) {
    const transition: RowTransition = {
      from: entry.current.state,
      to: state,
      interval: s.interval,
      afterMs: entry.current.last.toMs,
      byMs: s.toMs,
    }
    const action = this.#lastActionBefore(s.toMs)
    if (action)
      transition.afterAction = { name: action.name, atMs: action.atMs }
    entry.transitions.push(transition)
    const finding = this.#delayedUpdate(entry, transition, s)
    if (finding) this.#findings.push(finding)
    entry.current = { state, first: s, last: s }
  }

  #showUnexpected(row: string, state: string, s: RowSample) {
    if (!this.#unexpected.has(state)) return
    const open = this.#shown.get(row)
    // A row that left the region or showed another state in between starts a new finding.
    if (open?.finding.state === state && open.index === s.index - 1) {
      open.finding.lastSeenMs = s.toMs
      open.finding.samples++
      open.index = s.index
      return
    }
    const finding = this.#unexpectedFinding(row, state, s)
    this.#shown.set(row, { finding, index: s.index })
    this.#findings.push(finding)
  }

  #unexpectedFinding(
    row: string,
    state: string,
    s: RowSample,
  ): UnexpectedRowStateFinding {
    const action = this.#lastActionBefore(s.toMs)
    return {
      code: 'UNEXPECTED_ROW_STATE',
      kind: 'observation',
      basis: 'CONFIGURED_UNEXPECTED_STATE',
      interval: s.interval,
      row,
      state,
      firstSeenMs: [s.fromMs, s.toMs],
      lastSeenMs: s.toMs,
      samples: 1,
      afterAction: action && {
        name: action.name,
        atMs: action.atMs,
        seenAfterActionMs: [
          Math.max(0, s.fromMs - action.atMs),
          s.toMs - action.atMs,
        ],
      },
      note: 'The region showed a row in a state its configuration lists as unexpected. The rule comes from the configuration, so check that it holds for every row the region can show.',
    }
  }

  /**
   * A state change is a delayed update when the old state was seen in consecutive
   * samples, persisted past the lag threshold and across enough completed reads, and no
   * data event arrived to explain the change. Both states must be allowlisted.
   */
  #delayedUpdate(
    entry: RowEntry,
    transition: RowTransition,
    s: RowSample,
  ): DelayedUiUpdateFinding | null {
    const { first, last } = entry.current
    const c = this.#config
    if (
      last.index !== s.index - 1 ||
      !this.#labels.includes(transition.from) ||
      !this.#labels.includes(transition.to)
    )
      return null
    const persistedMs = last.toMs - first.fromMs
    const unchangedReads = last.completed - first.completed
    const sinceDataMs =
      s.data?.lastAtMs == null ? null : transition.afterMs - s.data.lastAtMs
    const dataQuiet =
      s.data === null ||
      (s.data.count === last.data!.count &&
        (sinceDataMs === null || sinceDataMs >= c.lagThresholdMs))
    if (
      persistedMs < c.lagThresholdMs ||
      unchangedReads < c.minUnchangedReads ||
      !dataQuiet
    )
      return null
    return this.#delayedFinding(entry, transition, s, {
      persistedMs,
      unchangedReads,
      sinceDataMs,
    })
  }

  /**
   * How long after the last user action the state `first` showed began, when it began
   * within the lag threshold. Such a stale state (an optimistic label, say) is the
   * strongest lead.
   */
  #startedAfterActionMs(first: RowSample) {
    const action = this.#lastActionBefore(first.toMs)
    if (!action || first.fromMs - action.atMs > this.#config.lagThresholdMs)
      return null
    return Math.max(0, first.fromMs - action.atMs)
  }

  #delayedFinding(
    { row, current: { first, last } }: RowEntry,
    transition: RowTransition,
    s: RowSample,
    measured: {
      persistedMs: number
      unchangedReads: number
      sinceDataMs: number | null
    },
  ): DelayedUiUpdateFinding {
    const startedAfterActionMs = this.#startedAfterActionMs(first)
    const action = transition.afterAction
    const finding: DelayedUiUpdateFinding = {
      code: 'DELAYED_UI_UPDATE',
      kind: 'observation',
      confidence: s.data && startedAfterActionMs !== null ? 'medium' : 'low',
      basis: s.data
        ? 'NO_DATA_EVENT_BEFORE_UI_CHANGE'
        : 'UNCHANGED_ACROSS_READS',
      interval: s.interval,
      row,
      from: transition.from,
      to: transition.to,
      changedAfterMs: transition.afterMs,
      changedByMs: transition.byMs,
      previousStateSinceMs: first.fromMs,
      previousStateStartedAfterActionMs: startedAfterActionMs,
      persistedMs: measured.persistedMs,
      unchangedReadCompletions: measured.unchangedReads,
      dataEventsWhilePersisted: s.data
        ? last.data!.count - first.data!.count
        : null,
      sinceLastDataEventMs: measured.sinceDataMs,
      afterAction: action
        ? {
            ...action,
            changedAfterActionMs: [
              transition.afterMs - action.atMs,
              transition.byMs - action.atMs,
            ],
          }
        : null,
      note: 'Row state persisted across completed selected reads and then changed without a data event in the sampled window. Read contents are not recorded, so this needs review against the application logic; it is not a defect verdict.',
    }
    finding.summary = observationSummary(finding)
    return finding
  }
}
