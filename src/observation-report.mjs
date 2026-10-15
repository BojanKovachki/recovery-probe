import { createRequire } from 'node:module'
import { escapeHtml, renderTemplate } from './report-template.mjs'
const { version } = createRequire(import.meta.url)('../package.json')

export function observationMetadata() {
  return {
    recoveryProbeVersion: version,
    runtime: { node: process.versions.node },
    browserVersion: null,
    ipcHook: null,
  }
}

// Aggregate every completed sample, including samples omitted from the change-only timeline.
export function samplingMetrics(requestedDelayMs) {
  let previous,
    count = 0,
    sum = 0,
    min = Infinity,
    max = 0
  let gaps = 0,
    gapSum = 0,
    gapMin = Infinity,
    gapMax = 0
  const phases = {}
  return {
    add(fromMs, toMs, timings = {}) {
      const duration = toMs - fromMs
      count++
      sum += duration
      min = Math.min(min, duration)
      max = Math.max(max, duration)
      if (previous !== undefined) {
        const gap = fromMs - previous
        gaps++
        gapSum += gap
        gapMin = Math.min(gapMin, gap)
        gapMax = Math.max(gapMax, gap)
      }
      previous = fromMs
      for (const key of [
        'beforeSnapshotMs',
        'uiRoundTripMs',
        'rendererReadMs',
        'summarizeMs',
        'afterSnapshotMs',
      ]) {
        const value = timings[key]
        if (!Number.isFinite(value) || value < 0) continue
        const p = (phases[key] ??= { count: 0, sum: 0, min: Infinity, max: 0 })
        p.count++
        p.sum += value
        p.min = Math.min(p.min, value)
        p.max = Math.max(p.max, value)
      }
    },
    snapshot() {
      const round = (n) => Math.round(n * 100) / 100
      const stats = (n, total, low, high) => ({
        count: n,
        meanMs: n ? round(total / n) : null,
        minMs: n ? round(low) : null,
        maxMs: n ? round(high) : null,
      })
      return {
        requestedDelayMs,
        completedSamples: count,
        sampleDuration: stats(count, sum, min, max),
        startToStart: stats(gaps, gapSum, gapMin, gapMax),
        phases: Object.fromEntries(
          Object.entries(phases).map(([key, p]) => [
            key,
            stats(p.count, p.sum, p.min, p.max),
          ]),
        ),
        note: 'The configured delay follows each completed sample. Sample duration brackets the UI read and following counter snapshot; cadence also includes other protocol work. These are completed-sample measurements, not guaranteed temporal coverage.',
      }
    },
  }
}

// Compare samples only; these summaries cannot establish ownership or freshness.
const contentEvidence = (e) => ({
  interval: e.interval,
  fromMs: e.fromMs,
  toMs: e.toMs,
  presence: e.ui.presence,
  visible: e.ui.visible,
  content: e.ui.content ?? null,
})
function compareContent(before, after) {
  const a = before.content,
    b = after.content
  const comparable =
    before.visible && after.visible && a && b && !a.truncated && !b.truncated
  return !comparable
    ? 'unavailable'
    : a.count === b.count && a.textFingerprint === b.textFingerprint
      ? 'unchanged'
      : 'changed'
}

export function contentComparison(basis, before, after) {
  const result = compareContent(contentEvidence(before), contentEvidence(after))
  return {
    kind: 'observation',
    basis,
    interval: after.interval,
    result,
    before: contentEvidence(before),
    after: contentEvidence(after),
    ...(basis === 'READ_COMPLETION'
      ? {
          completions: {
            successes: after.before.successes - before.after.successes,
            errors: after.before.errors - before.after.errors,
          },
        }
      : { reads: after.reads }),
    summary: `${basis === 'READ_COMPLETION' ? 'Across observed read completion(s)' : 'On the first sampled content in this interval'}, selected marker text/count comparison: ${result}.`,
    note: 'Ordered normalized visible marker text/count only. Other values, ownership, freshness and changes between samples are unknown. Completion does not imply renderer consumption.',
  }
}

export function comparisonFollowUpSummary(comparison) {
  const f = comparison.followUp
  if (!f) return '' // Reports from older versions have no follow-up evidence.
  if (!f.samples) return 'No later sample in this interval.'
  const matched = f.firstBaselineMatch
  const prefix =
    comparison.result === 'changed' && matched
      ? `Initially different; a later sample matched the baseline (${matched.fromMs}–${matched.toMs} ms from capture start). `
      : ''
  return `${prefix}Latest follow-up sample (${f.latest.fromMs}–${f.latest.toMs} ms from capture start): ${f.latest.result} against the baseline. ${f.comparableSamples} comparable, ${f.unavailableSamples} unavailable later samples. These samples do not establish continuous visibility or stability.`
}

export function contentComparisons() {
  let interval,
    anchor,
    lastContent,
    returnBaseline,
    comparedReturn = false
  let active = [],
    retained = 0
  const completed = (counts) => counts.successes + counts.errors
  return {
    add(event) {
      const results = []
      if (interval !== event.interval) {
        interval = event.interval
        anchor = undefined
        returnBaseline = lastContent
        comparedReturn = false
        active = [] // Later intervals cannot resolve an earlier comparison.
      }
      for (const comparison of active) {
        const f = comparison.followUp
        const evidence = contentEvidence(event)
        const result = compareContent(comparison.before, evidence)
        f.samples++
        if (result === 'unavailable') f.unavailableSamples++
        else f.comparableSamples++
        f.latest = { ...evidence, result }
        if (result === 'unchanged' && !f.firstBaselineMatch)
          f.firstBaselineMatch = evidence
        f.summary = comparisonFollowUpSummary(comparison)
      }
      if (event.ui.visible && event.ui.contentCount > 0) {
        if (returnBaseline && !comparedReturn)
          results.push(
            contentComparison('INTERVAL_RETURN', returnBaseline, event),
          )
        comparedReturn = true
        lastContent = event
      }
      if (anchor && completed(event.after) > completed(anchor.after)) {
        // A completion during the UI read is ambiguous. Retain the earlier
        // sample until a later UI read is bracketed by settled counters.
        if (completed(event.before) === completed(event.after)) {
          results.push(contentComparison('READ_COMPLETION', anchor, event))
          anchor = event
        }
      } else anchor = event
      for (const comparison of results) {
        // Match the report's global comparison cap; do not retain discarded evidence.
        if (retained >= 1000) break
        comparison.followUp = {
          samples: 0,
          comparableSamples: 0,
          unavailableSamples: 0,
          firstBaselineMatch: null,
          latest: null,
          summary: 'No later sample in this interval.',
        }
        retained++
        active.push(comparison)
      }
      return results
    },
  }
}

const seconds = (ms) => (Math.round(ms / 100) / 10).toFixed(1)
const range = ([low, high]) => {
  const a = seconds(Math.max(0, low)),
    b = seconds(high)
  return a === b ? `about ${a} s` : `${a}–${b} s`
}
const rowName = (row) =>
  row.startsWith('key:') ? `row ${row.slice(4, 12)}` : `row ‘${row}’`

export function observationSummary(finding) {
  if (finding.code === 'DELAYED_UI_UPDATE') {
    const data =
      finding.basis === 'NO_DATA_EVENT_BEFORE_UI_CHANGE'
        ? `; no data event arrived in the change window${finding.sinceLastDataEventMs === null ? '' : ` (the last one was ${seconds(finding.sinceLastDataEventMs)} s earlier)`}`
        : '; data events were not observed for this target'
    const action = finding.afterAction
      ? ` The change came ${range(finding.afterAction.changedAfterActionMs)} after action ‘${finding.afterAction.name}’${finding.previousStateStartedAfterActionMs == null ? '; the earlier state did not start right after an action' : '; the earlier state started right after it'}.`
      : ''
    return `${rowName(finding.row)[0].toUpperCase()}${rowName(finding.row).slice(1)} stayed ${finding.from} for ${seconds(finding.persistedMs)} s across ${finding.unchangedReadCompletions} completed selected reads, then changed to ${finding.to}${data}.${action}`
  }
  if (finding.basis === 'NO_READ_OBSERVED_IN_INTERVAL')
    return 'Content was visible without a new selected read in this interval.'
  if (finding.basis === 'NO_COMPLETION_OBSERVED_IN_INTERVAL')
    return 'Content was visible before any selected read completed in this interval (a read was pending or had started).'
  return 'Content/read ordering was observed; inspect the evidence.'
}

/** Rows that appeared or changed after each configured action, relative to the action time. */
export function actionEffects(report) {
  const actions = report.actions ?? []
  const same = (ref, action) =>
    ref && ref.name === action.name && ref.atMs === action.atMs
  return actions.map((action) => {
    const appeared = (report.rows ?? [])
      .filter((r) => same(r.firstSeen.afterAction, action))
      .map((r) => ({
        row: r.row,
        state: r.firstSeen.state,
        appearedAfterMs: [
          r.firstSeen.fromMs - action.atMs,
          r.firstSeen.toMs - action.atMs,
        ],
        changes: r.transitions
          .filter((t) => same(t.afterAction, action))
          .map((t) => ({
            from: t.from,
            to: t.to,
            afterActionMs: [t.afterMs - action.atMs, t.byMs - action.atMs],
          })),
      }))
    const changed = (report.rows ?? [])
      .filter((r) => !same(r.firstSeen.afterAction, action))
      .flatMap((r) =>
        r.transitions
          .filter((t) => same(t.afterAction, action))
          .map((t) => ({
            row: r.row,
            from: t.from,
            to: t.to,
            afterActionMs: [t.afterMs - action.atMs, t.byMs - action.atMs],
          })),
      )
    return { ...action, appeared, changed }
  })
}

export function actionSummary(effect) {
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
      `${quiet.length} row${quiet.length === 1 ? '' : 's'} without a tracked state appeared`,
    )
  return `Action ‘${effect.name}’ at ${seconds(effect.atMs)} s (${effect.trusted ? 'trusted input' : 'scripted, untrusted event'}): ${parts.length ? parts.join('; ') : 'no tracked row appeared or changed'}.`
}

/** One line per interval instead of one per comparison. */
export function comparisonDigest(report) {
  const byInterval = new Map()
  for (const c of report.comparisons ?? []) {
    const entry = byInterval.get(c.interval) ?? {}
    const key = `${c.basis === 'READ_COMPLETION' ? 'read-completion' : 'interval-return'} ${c.result}${c.basis === 'INTERVAL_RETURN' && c.result === 'changed' && c.followUp?.firstBaselineMatch ? ' (later matched)' : ''}`
    entry[key] = (entry[key] ?? 0) + 1
    byInterval.set(c.interval, entry)
  }
  return [...byInterval].map(
    ([index, entry]) =>
      `Interval ${index} comparisons: ${Object.entries(entry)
        .map(([key, n]) => `${n} ${key}`)
        .join(', ')}.`,
  )
}

const trackedRowHtml = (r) => {
  const changes = r.transitions
    .map(
      (t) =>
        `${escapeHtml(t.from)} → ${escapeHtml(t.to)} at ${seconds(t.afterMs)}–${seconds(t.byMs)} s`,
    )
    .join('<br>')
  return `<tr><td>${escapeHtml(rowName(r.row))}</td><td>${seconds(r.firstSeen.fromMs)}–${seconds(r.firstSeen.toMs)} s as ${escapeHtml(r.firstSeen.state)}</td><td>${changes || 'none'}</td><td>${escapeHtml(r.lastState)}</td></tr>`
}

export function renderObservationReport(report) {
  const intervals = report.intervals
    .map(
      (i) =>
        `<tr><td>${i.index}</td><td>${i.reads?.calls ?? 'unknown'}</td><td>${i.reads?.successes ?? 'unknown'}</td><td>${i.reads?.errors ?? 'unknown'}</td><td>${i.firstContent ? `${i.firstContent.fromMs - i.startMs}–${i.firstContent.toMs - i.startMs} ms` : 'not sampled'}</td></tr>`,
    )
    .join('')
  const sampling = report.sampling
  const comparisons = (report.comparisons ?? [])
    .map(
      (c) =>
        `<p>Interval ${escapeHtml(c.interval)}: ${escapeHtml(c.summary)} ${c.completions ? `(${c.completions.successes} successful, ${c.completions.errors} failed read completions)` : `(${c.reads.calls} selected reads started in this interval)`} ${escapeHtml(comparisonFollowUpSummary(c))}</p>`,
    )
    .join('')
  const phaseRows = Object.entries(sampling?.phases ?? {})
    .map(
      ([name, s]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${s.meanMs}</td><td>${s.maxMs}</td></tr>`,
    )
    .join('')
  const effects = report.actionEffects ?? []
  const actionsHtml = effects.length
    ? `<h2>Actions</h2>${effects.map((e) => `<p>${escapeHtml(actionSummary(e))}</p>`).join('')}`
    : ''
  const trackedRows = report.rows?.length
    ? `<h2>Tracked rows</h2><table><thead><tr><th>Row</th><th>First seen</th><th>State changes</th><th>Last state</th></tr></thead><tbody>${report.rows.map(trackedRowHtml).join('')}</tbody></table><p>Row keys are hashed unless an alias was configured. States outside the configured allowlist are recorded as “other”.</p>`
    : ''
  const notes = (report.notes ?? [])
    .map((n) => `<p>Note: ${escapeHtml(n.note)}</p>`)
    .join('')
  const operatorHtml = report.operator
    ? `<p>Scripted steps: ${escapeHtml(report.operator.status)}${report.operator.error ? ` — ${escapeHtml(report.operator.error)}` : ''}.</p>`
    : ''
  const samplingHtml = sampling
    ? `<p>Configured delay: ${sampling.requestedDelayMs} ms. Completed samples: ${sampling.completedSamples}. Mean sample duration: ${sampling.sampleDuration.meanMs ?? 'unavailable'} ms. Mean start-to-start cadence: ${sampling.startToStart.meanMs ?? 'unavailable'} ms (maximum ${sampling.startToStart.maxMs ?? 'unavailable'} ms).</p><p>${escapeHtml(sampling.note)}</p>`
    : ''
  const phases = phaseRows
    ? `<table><thead><tr><th>Measured phase</th><th>Mean ms</th><th>Maximum ms</th></tr></thead><tbody>${phaseRows}</tbody></table><p>Renderer read time is included in the UI round trip, not additional to it.</p>`
    : ''
  const findings = report.findings
    .map(
      (f) =>
        `<p>Interval ${f.interval}: ${escapeHtml(observationSummary(f))} <strong>${escapeHtml(f.code)}</strong> — ${escapeHtml(f.basis)}</p>`,
    )
    .join('')
  return renderTemplate('observation', {
    status: report.status,
    version: report.metadata?.recoveryProbeVersion ?? 'unknown',
    node: report.metadata?.runtime?.node ?? 'unknown',
    browser: report.metadata?.browserVersion ?? 'unknown',
    ipcHook: report.metadata?.ipcHook?.version ?? 'unknown / not applicable',
    sampling: samplingHtml,
    detail: report.detail ?? 'region (legacy)',
    phases,
    limitation: report.limitation ?? report.error,
    intervals,
    findings,
    operator: operatorHtml,
    actions: actionsHtml,
    trackedRows,
    notes,
    comparisons,
    cleanup: report.cleanup ?? 'unknown',
    evidence: JSON.stringify(report, null, 2),
  })
}
