/** Marks the evidence block every report.json carries; compare, watch and verify read it. */
export const EVIDENCE_SCHEMA = 'recovery-probe/evidence@1'

export type Workflow = 'check' | 'discover' | 'refresh' | 'observe' | 'action'
/** How the read was failed: an HTTP route, the IPC hook, or the JSON runner's browser. */
export type Transport = 'http' | 'ipc' | 'browser'

/** A suspected defect or failed check, or a lead to review. */
export type ProblemSeverity = 'defect' | 'lead'

export interface Problem {
  code: string
  /** The fault, experiment or scenario it was found under, when the report has several. */
  scope?: string
  severity: ProblemSeverity
}

/** What one report shows, in the same shape for every workflow. */
export interface Evidence {
  schema: typeof EVIDENCE_SCHEMA
  workflow: Workflow
  transport?: Transport
  /** The endpoint, channel, trigger or app the run checked. */
  target?: string
  /** Whether the run finished well enough for a missing problem to count. */
  complete: boolean
  /** Why parts of the run do not count: errors, inconclusive rows, coverage gaps. */
  gaps: string[]
  problems: Problem[]
  /** Results that are not problems, such as RECOVERED or FEEDBACK_SHOWN. */
  outcomes: string[]
  /** Scopes the run checked to the end; '' stands for the whole check. */
  checked: string[]
}

export interface Kind {
  workflow: Workflow
  transport?: Transport
}

type Report = Record<string, unknown>
type Row = Record<string, unknown>

const list = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((item): item is Row => !!item && typeof item === 'object')
    : []
const string = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined
export const scoped = (code: string, scope?: string) =>
  scope ? `${code} (${scope})` : code
/** The first line of an error, enough to say why a run stopped. */
const briefly = (text: string) => text.split('\n')[0].slice(0, 160)

// Reports written before the evidence block, by the label in their mode field.
const KINDS: Record<string, Kind> = {
  'desktop renderer recovery': { workflow: 'check', transport: 'http' },
  'attached browser recovery': { workflow: 'check', transport: 'http' },
  'web recovery': { workflow: 'check', transport: 'http' },
  'web guided recovery': { workflow: 'check', transport: 'http' },
  'desktop guided recovery': { workflow: 'check', transport: 'http' },
  'IPC renderer recovery': { workflow: 'check', transport: 'ipc' },
  'configured recovery check': { workflow: 'check', transport: 'browser' },
  'controlled demonstration': { workflow: 'check', transport: 'browser' },
  'experimental IPC discovery': { workflow: 'discover', transport: 'ipc' },
  'HTTP discovery': { workflow: 'discover', transport: 'http' },
  'IPC action check': { workflow: 'action', transport: 'ipc' },
  'refresh experiment': { workflow: 'refresh' },
  'fault-free observation': { workflow: 'observe' },
  'observation with network faults': { workflow: 'observe' },
  'observation with file faults': { workflow: 'observe' },
  'observation with network and file faults': { workflow: 'observe' },
}

/** What a report is, from its evidence block or, for older reports, its mode. */
export function kindOf(report: Report): Kind | undefined {
  const evidence = report.evidence as Partial<Evidence> | undefined
  if (evidence?.schema === EVIDENCE_SCHEMA && evidence.workflow)
    return { workflow: evidence.workflow, transport: evidence.transport }
  const kind = KINDS[string(report.mode) ?? '']
  if (!kind) return undefined
  // Refresh and observation reports name their transport.
  const transport = string(report.transport)
  return kind.transport || !transport
    ? kind
    : { ...kind, transport: transport as Transport }
}

function targetOf(report: Report): string | undefined {
  const readiness = report.readiness as Record<string, unknown> | undefined
  const trigger = report.trigger as Record<string, unknown> | undefined
  const apps = list(report.apps)
  return (
    string(report.channel) ??
    string(report.endpoint) ??
    string(report.target) ??
    (Array.isArray(readiness?.relevantEndpoints)
      ? string(readiness.relevantEndpoints[0])
      : undefined) ??
    string(trigger?.name) ??
    (apps.length
      ? apps.map((app) => string(app.name) ?? '?').join(', ')
      : undefined)
  )
}

// Reports with a row per fault: pass, fail, inconclusive or skipped.
function fromCheck(report: Report, evidence: Evidence) {
  const baseline = report.baseline as Row | undefined
  if (baseline && baseline.outcome !== 'pass') {
    evidence.gaps.push(`baseline ${string(baseline.code) ?? 'did not pass'}`)
    evidence.complete = false
  }
  const rows = report.apps
    ? list(report.apps).flatMap((app) => list(app.results))
    : list(report.results)
  for (const row of rows) {
    const code = string(row.code) ?? 'UNKNOWN'
    const scope = string(row.kind) ?? string(row.fault) ?? string(row.scenario)
    if (row.outcome === 'fail') {
      evidence.problems.push({ code, scope, severity: 'defect' })
      if (scope) evidence.checked.push(scope)
    } else if (row.outcome === 'pass') {
      evidence.outcomes.push(scoped(code, scope))
      if (scope) evidence.checked.push(scope)
    } else evidence.gaps.push(scoped(code, scope))
  }
  if (!evidence.checked.length) evidence.complete = false
}

// Reports with findings classified as suspected-defect, decision-needed,
// observation (good outcomes such as RECOVERED) or inconclusive.
function fromFindings(report: Report, evidence: Evidence) {
  if (report.failedControl) {
    evidence.gaps.push('the control run failed')
    evidence.complete = false
  }
  let conclusive = 0
  for (const finding of list(report.findings)) {
    const code = string(finding.classification) ?? 'UNKNOWN'
    // The experiment's id keeps rejection-1, rejection-2 and later calls apart.
    const scope = string(finding.id) ?? string(finding.fault)
    if (finding.kind === 'inconclusive' || finding.partial) {
      evidence.gaps.push(scoped(code, scope))
      continue
    }
    conclusive++
    if (scope) evidence.checked.push(scope)
    if (finding.kind === 'suspected-defect')
      evidence.problems.push({ code, scope, severity: 'defect' })
    else if (finding.kind === 'decision-needed')
      evidence.problems.push({ code, scope, severity: 'lead' })
    else evidence.outcomes.push(scoped(code, scope))
  }
  if (!conclusive) evidence.complete = false
}

// Observation findings are leads, except an expect step the app did not meet, which is
// a failed check; any coverage gap makes the run partial.
function fromObservation(report: Report, evidence: Evidence) {
  if (report.status !== 'complete' || report.captureComplete === false) {
    evidence.gaps.push(`capture ${string(report.status) ?? 'incomplete'}`)
    evidence.complete = false
  }
  const coverage = report.coverage as Record<string, unknown> | undefined
  for (const gap of Array.isArray(coverage?.gaps) ? coverage.gaps : []) {
    evidence.gaps.push(String(gap))
    evidence.complete = false
  }
  for (const finding of list(report.findings)) {
    const code = string(finding.code) ?? 'UNKNOWN'
    if (!evidence.problems.some((problem) => problem.code === code))
      evidence.problems.push({
        code,
        severity: code === 'EXPECTATION_NOT_MET' ? 'defect' : 'lead',
      })
  }
}

/**
 * Reduces a report to what can be compared. Writers call it with the kind they
 * know; for a report written before the evidence block, its mode gives the kind.
 */
export function evidenceOf(
  report: Report,
  kind: Kind | undefined = kindOf(report),
): Evidence {
  if (!kind) throw new Error('Not a Recovery Probe report')
  const evidence: Evidence = {
    schema: EVIDENCE_SCHEMA,
    ...kind,
    target: targetOf(report),
    complete: true,
    gaps: [],
    problems: [],
    outcomes: [],
    checked: [],
  }
  const error = string(report.error)
  if (error) {
    evidence.gaps.push(`error: ${briefly(error)}`)
    evidence.complete = false
  }
  if (kind.workflow === 'observe') fromObservation(report, evidence)
  else if (kind.workflow === 'check') fromCheck(report, evidence)
  else fromFindings(report, evidence)
  evidence.checked = evidence.complete
    ? [...new Set(['', ...evidence.checked])]
    : []
  return evidence
}

/** The report with its evidence block, ready to save as report.json. */
export function withEvidence<T extends object>(
  report: T,
  kind: Kind | undefined = kindOf(report as Report),
): T & { evidence?: Evidence } {
  return kind
    ? { ...report, evidence: evidenceOf(report as Report, kind) }
    : report
}
