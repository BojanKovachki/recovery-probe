import { escapeHtml, renderTemplate } from '../../reports/template.mjs'
import { comparisonFollowUpSummary } from './comparisons.mjs'
import type { ObservationReport, TrackedRow } from './report.mjs'
import {
  actionSummary,
  fileFaultSummary,
  networkStepSummary,
  observationSummary,
  rowName,
  seconds,
} from './summaries.mjs'

const paragraphs = (lines: string[]) =>
  lines.map((line) => `<p>${line}</p>`).join('')
const list = (items: string[]) =>
  `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`

export function renderObservationReport(report: ObservationReport): string {
  return renderTemplate('observation', {
    status: report.status,
    ...versions(report),
    sampling: samplingHtml(report),
    detail: report.detail ?? 'region (legacy)',
    phases: phasesHtml(report),
    limitation: report.limitation ?? report.error,
    intervals: intervalsHtml(report),
    findings: findingsHtml(report),
    operator: stepsHtml(report),
    actions: actionsHtml(report),
    trackedRows: trackedRowsHtml(report),
    notes: paragraphs(
      (report.notes ?? []).map((n) => `Note: ${escapeHtml(n.note)}`),
    ),
    comparisons: comparisonsHtml(report),
    cleanup: report.cleanup ?? 'unknown',
    evidence: JSON.stringify(report, null, 2),
  })
}

/** What ran the capture; older or failed reports may not say. */
function versions({ metadata }: ObservationReport) {
  return {
    version: metadata?.recoveryProbeVersion ?? 'unknown',
    node: metadata?.runtime?.node ?? 'unknown',
    browser: metadata?.browserVersion ?? 'unknown',
    ipcHook: metadata?.ipcHook?.version ?? 'unknown / not applicable',
  }
}

function intervalsHtml(report: ObservationReport) {
  return report.intervals
    .map((i) => {
      const reads = i.reads
      const content = i.firstContent
        ? `${i.firstContent.fromMs - i.startMs}–${i.firstContent.toMs - i.startMs} ms`
        : 'not sampled'
      return `<tr><td>${i.index}</td><td>${reads?.calls ?? 'unknown'}</td><td>${reads?.successes ?? 'unknown'}</td><td>${reads?.errors ?? 'unknown'}</td><td>${content}</td></tr>`
    })
    .join('')
}

function findingsHtml(report: ObservationReport) {
  return paragraphs(
    report.findings.map(
      (f) =>
        `Interval ${f.interval}: ${escapeHtml(observationSummary(f))} <strong>${escapeHtml(f.code)}</strong> — ${escapeHtml(f.basis)}`,
    ),
  )
}

function comparisonsHtml(report: ObservationReport) {
  return paragraphs(
    (report.comparisons ?? []).map((c) => {
      const counts = c.completions
        ? `(${c.completions.successes} successful, ${c.completions.errors} failed read completions)`
        : `(${c.reads?.calls} selected reads started in this interval)`
      return `Interval ${escapeHtml(c.interval)}: ${escapeHtml(c.summary)} ${counts} ${escapeHtml(comparisonFollowUpSummary(c))}`
    }),
  )
}

function samplingHtml({ sampling }: ObservationReport) {
  if (!sampling) return ''
  const ms = (value: number | null) => value ?? 'unavailable'
  return `<p>Configured delay: ${sampling.requestedDelayMs} ms. Completed samples: ${sampling.completedSamples}. Mean sample duration: ${ms(sampling.sampleDuration.meanMs)} ms. Mean start-to-start cadence: ${ms(sampling.startToStart.meanMs)} ms (maximum ${ms(sampling.startToStart.maxMs)} ms).</p><p>${escapeHtml(sampling.note)}</p>`
}

function phasesHtml({ sampling }: ObservationReport) {
  const rows = Object.entries(sampling?.phases ?? {})
    .map(
      ([name, s]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${s.meanMs}</td><td>${s.maxMs}</td></tr>`,
    )
    .join('')
  if (!rows) return ''
  return `<table><thead><tr><th>Measured phase</th><th>Mean ms</th><th>Maximum ms</th></tr></thead><tbody>${rows}</tbody></table><p>Renderer read time is included in the UI round trip, not additional to it.</p>`
}

/** Scripted steps, then what their network and file faults did. */
function stepsHtml(report: ObservationReport) {
  const { operator, network, fileFaults } = report
  const steps = operator
    ? `<p>Scripted steps: ${escapeHtml(operator.status)}${operator.error ? ` — ${escapeHtml(operator.error)}` : ''}.</p>`
    : ''
  const restoreError = network?.restoreError
    ? `<p>Network faults were not removed: ${escapeHtml(network.restoreError)}</p>`
    : ''
  const networkFaults = network
    ? list(network.faults.map(networkStepSummary)) + restoreError
    : ''
  const files = fileFaults?.length ? list(fileFaults.map(fileFaultSummary)) : ''
  return steps + networkFaults + files
}

function actionsHtml(report: ObservationReport) {
  const effects = report.actionEffects ?? []
  if (!effects.length) return ''
  return `<h2>Actions</h2>${paragraphs(effects.map((e) => escapeHtml(actionSummary(e))))}`
}

function trackedRowsHtml({ rows }: ObservationReport) {
  if (!rows?.length) return ''
  return `<h2>Tracked rows</h2><table><thead><tr><th>Row</th><th>First seen</th><th>State changes</th><th>Last state</th></tr></thead><tbody>${rows.map(trackedRowHtml).join('')}</tbody></table><p>Row keys are hashed unless an alias was configured. A configured marker names the state; otherwise text outside the configured allowlist is recorded as “other”.</p>`
}

function trackedRowHtml(r: TrackedRow) {
  const changes = r.transitions
    .map(
      (t) =>
        `${escapeHtml(t.from)} → ${escapeHtml(t.to)} at ${seconds(t.afterMs)}–${seconds(t.byMs)} s`,
    )
    .join('<br>')
  return `<tr><td>${escapeHtml(rowName(r.row))}</td><td>${seconds(r.firstSeen.fromMs)}–${seconds(r.firstSeen.toMs)} s as ${escapeHtml(r.firstSeen.state)}</td><td>${changes || 'none'}</td><td>${escapeHtml(r.lastState)}</td></tr>`
}
