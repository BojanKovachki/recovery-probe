import type { ActionEffect } from './action-effects.mjs'
import type {
  DelayedUiUpdateFinding,
  FileFaultRecord,
  NetworkStepRecord,
  ObservationFinding,
  UnexpectedRowStateFinding,
} from './report.mjs'
import type { FileFault } from './steps.mjs'

export const seconds = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1)

const range = ([low, high]: readonly [number, number]) => {
  const a = seconds(Math.max(0, low)),
    b = seconds(high)
  return a === b ? `about ${a} s` : `${a}–${b} s`
}

export const rowName = (row: string) =>
  row.startsWith('key:') ? `row ${row.slice(4, 12)}` : `row ‘${row}’`

const capitalizedRowName = (row: string) =>
  rowName(row)[0].toUpperCase() + rowName(row).slice(1)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const isDelayedUiUpdate = (
  finding: ObservationFinding,
): finding is DelayedUiUpdateFinding => finding.code === 'DELAYED_UI_UPDATE'

const isUnexpectedRowState = (
  finding: ObservationFinding,
): finding is UnexpectedRowStateFinding =>
  finding.code === 'UNEXPECTED_ROW_STATE'

// These findings are summarized where they are found.
const SUMMARIZED_WHERE_FOUND = new Set([
  'LOCAL_FILES_REMOVED',
  'LOCAL_FILE_NOT_REPAIRED',
  'EXPECTATION_NOT_MET',
])

const CONTENT_BEFORE_READ = new Map([
  [
    'NO_READ_OBSERVED_IN_INTERVAL',
    'Content was visible without a new selected read in this interval.',
  ],
  [
    'NO_COMPLETION_OBSERVED_IN_INTERVAL',
    'Content was visible before any selected read completed in this interval (a read was pending or had started).',
  ],
])

export function observationSummary(finding: ObservationFinding): string {
  if (isDelayedUiUpdate(finding)) return delayedUpdateSummary(finding)
  if (isUnexpectedRowState(finding)) return unexpectedStateSummary(finding)
  if (SUMMARIZED_WHERE_FOUND.has(finding.code) && finding.summary)
    return finding.summary
  return (
    CONTENT_BEFORE_READ.get(finding.basis) ??
    'Content/read ordering was observed; inspect the evidence.'
  )
}

function delayedUpdateSummary(finding: DelayedUiUpdateFinding) {
  const data =
    finding.basis === 'NO_DATA_EVENT_BEFORE_UI_CHANGE'
      ? `; no data event arrived in the change window${finding.sinceLastDataEventMs === null ? '' : ` (the last one was ${seconds(finding.sinceLastDataEventMs)} s earlier)`}`
      : '; data events were not observed for this target'
  const action = finding.afterAction
    ? ` The change came ${range(finding.afterAction.changedAfterActionMs)} after action ‘${finding.afterAction.name}’${finding.previousStateStartedAfterActionMs == null ? '; the earlier state did not start right after an action' : '; the earlier state started right after it'}.`
    : ''
  return `${capitalizedRowName(finding.row)} stayed ${finding.from} for ${seconds(finding.persistedMs)} s across ${finding.unchangedReadCompletions} completed selected reads, then changed to ${finding.to}${data}.${action}`
}

function unexpectedStateSummary(finding: UnexpectedRowStateFinding) {
  const action = finding.afterAction
    ? `; first seen ${range(finding.afterAction.seenAfterActionMs)} after action ‘${finding.afterAction.name}’`
    : ''
  return `${capitalizedRowName(finding.row)} showed ${finding.state}, which this region must not show, in ${plural(finding.samples, 'sample')} from ${range(finding.firstSeenMs)} to ${seconds(finding.lastSeenMs)} s${action}.`
}

export function actionSummary(effect: ActionEffect): string {
  // Rows without a tracked state that merely appeared (for example after navigating) are counted, not listed.
  const quiet = effect.appeared.filter(
    (a) => ['none', 'other'].includes(a.state) && !a.changes.length,
  )
  const parts = effect.appeared
    .filter((a) => !quiet.includes(a))
    .map(
      (a) =>
        `${rowName(a.row)} appeared ${range(a.appearedAfterMs)} later as ${a.state}${a.changes.map((c) => `, then ${c.from} → ${c.to} ${range(c.afterActionMs)} after the action`).join('')}`,
    )
  parts.push(
    ...effect.changed.map(
      (c) =>
        `${rowName(c.row)} changed ${c.from} → ${c.to} ${range(c.afterActionMs)} after the action`,
    ),
  )
  if (quiet.length)
    parts.push(
      `${plural(quiet.length, 'row')} without a tracked state appeared`,
    )
  return `Action ‘${effect.name}’ at ${seconds(effect.atMs)} s (${effect.trusted ? 'trusted input' : 'scripted, untrusted event'}): ${parts.length ? parts.join('; ') : 'no tracked row appeared or changed'}.`
}

export const networkStepSummary = (record: NetworkStepRecord): string => {
  if (record.restored) return `Step ${record.step}: network restored`
  if (!record.rules)
    return `Step ${record.step}: network faults armed; what they faulted is unknown`
  return record.rules
    .map(
      (rule) =>
        `Step ${record.step}: ${rule.fault} ${rule.host} faulted ${rule.applied} of ${rule.matching} matching connection(s)`,
    )
    .join('; ')
}

export const DAMAGED: Record<FileFault, string> = {
  remove: 'removed',
  truncate: 'truncated',
  corrupt: 'corrupted',
}

export function fileFaultSummary(record: FileFaultRecord): string {
  const damaged = DAMAGED[record.fault]
  const putBack = record.restored ? '; Recovery Probe put it back' : ''
  if (record.error)
    return `Step ${record.step}: the ${damaged} file could not be checked or put back (${record.error}); its original is kept, see files.json`
  if (record.outcome === 'repaired')
    return `Step ${record.step}: the app restored the file the step ${damaged}`
  if (record.outcome === 'damaged')
    return `Step ${record.step}: the file the step ${damaged} was still ${record.fault === 'remove' ? 'missing' : damaged} when the capture ended${putBack}`
  return `Step ${record.step}: the app changed the file the step ${damaged}, but it did not hold the original content when the capture ended${putBack}`
}
