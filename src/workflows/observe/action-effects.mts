import type {
  ActionRef,
  ObservedAction,
  RowTransition,
  TrackedRow,
} from './report.mjs'

export interface ActionEffect extends ObservedAction {
  appeared: {
    row: string
    state: string
    appearedAfterMs: [number, number]
    changes: { from: string; to: string; afterActionMs: [number, number] }[]
  }[]
  changed: {
    row: string
    from: string
    to: string
    afterActionMs: [number, number]
  }[]
}

const same = (ref: ActionRef | null | undefined, action: ObservedAction) =>
  ref != null && ref.name === action.name && ref.atMs === action.atMs

/** The state changes `action` caused, timed from the action. */
const changesAfter = (transitions: RowTransition[], action: ObservedAction) =>
  transitions
    .filter((t) => same(t.afterAction, action))
    .map((t) => ({
      from: t.from,
      to: t.to,
      afterActionMs: [t.afterMs - action.atMs, t.byMs - action.atMs] as [
        number,
        number,
      ],
    }))

/** Rows that appeared or changed after each configured action, relative to the action time. */
export function actionEffects(report: {
  actions?: ObservedAction[] | null
  rows?: TrackedRow[] | null
}): ActionEffect[] {
  const rows = report.rows ?? []
  return (report.actions ?? []).map((action) => {
    const appeared = rows
      .filter((r) => same(r.firstSeen.afterAction, action))
      .map((r) => ({
        row: r.row,
        state: r.firstSeen.state,
        appearedAfterMs: [
          r.firstSeen.fromMs - action.atMs,
          r.firstSeen.toMs - action.atMs,
        ] as [number, number],
        changes: changesAfter(r.transitions, action),
      }))
    const changed = rows
      .filter((r) => !same(r.firstSeen.afterAction, action))
      .flatMap((r) =>
        changesAfter(r.transitions, action).map((change) => ({
          row: r.row,
          ...change,
        })),
      )
    return { ...action, appeared, changed }
  })
}
