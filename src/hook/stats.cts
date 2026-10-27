import type { LabelFunction } from './checks.cjs'
import type { IpcReadStats } from './types.cjs'

const MAX_LABELS = 200

export const readStats = (): IpcReadStats => ({
  calls: 0,
  successes: 0,
  errors: 0,
  pending: 0,
  firstReadAt: null,
  lastReadAt: null,
  firstCompletedAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
})

// Labels are developer-chosen method names, never argument values.
const label = (value: unknown) =>
  typeof value === 'string' && /^[\w.:/-]{1,100}$/.test(value) ? value : null

/**
 * The label `classify` gives a call, '(other)' once `table` holds the most labels it
 * keeps, or null without a classifier. A classifier failure or an unexpected label
 * must never affect the real call.
 */
export function classifyCall(
  classify: LabelFunction | undefined,
  channel: string,
  args: unknown[],
  table: Record<string, unknown>,
): string | null {
  if (!classify) return null
  let name: string
  try {
    name = label(classify(channel, args)) ?? 'unclassified'
  } catch {
    name = 'unclassified'
  }
  return table[name] || Object.keys(table).length < MAX_LABELS
    ? name
    : '(other)'
}
