import type { Suspect } from '../suspects/source.mjs'
import type { ChangedFile } from './changes.mjs'
import type { Registry } from './registry.mjs'
import type { Selection, Suggestion } from './select.mjs'
import type { SelfCheckStatus } from './self-check-status.mjs'

/** Something a person has to supply or decide before the plan can cover a change. */
export interface InputRequest {
  kind:
    | 'no-registry'
    | 'unusable-entry'
    | 'invalid-entry'
    | 'missing-expectation'
    | 'question'
    | 'stale-pattern'
    | 'scenario-needed'
    | 'unknown-entry'
    | 'too-many-checks'
    | 'self-check'
  entry?: string
  /** The changed files it concerns. */
  files?: string[]
  message: string
}

interface GapInput {
  registry: Registry | null
  registryPath: string
  changes: ChangedFile[]
  found: Selection[]
  suggestions: Suggestion[]
  suspects: Suspect[]
  stale: { entry: string; pattern: string }[]
  expectations: Record<string, string>
  planned: number
  selfChecks: { entry: string; status: SelfCheckStatus }[]
}

const filesOf = (found: Selection[], entry: string) =>
  found.filter((s) => s.entry === entry).map((s) => s.file)

/** Planned scenarios whose saved self-check was not clean, or whose check changed since. */
const selfCheckRequests = (input: GapInput): InputRequest[] =>
  input.selfChecks
    .filter(({ status }) => status.inputsChanged || status.outcome !== 'clean')
    .map(({ entry, status }) => ({
      kind: 'self-check' as const,
      entry,
      message: status.inputsChanged
        ? `${entry}: its check or the files it reads changed since the self-check of ${status.at}; run the self-check again before relying on it`
        : `${entry}: the self-check of ${status.at} on the reference build "${status.reference}" had the outcome ${status.outcome}; see .recovery-probe/self-check/report.md before relying on it`,
    }))

/** What the registry itself needs: unusable and invalid entries, stale patterns, unknown names. */
function registryRequests(input: GapInput): InputRequest[] {
  const { registry, registryPath, found, stale, expectations } = input
  if (!registry)
    return [
      {
        kind: 'no-registry',
        message: `No registry at ${registryPath}: map source files to existing checks first (see docs/plan.md). Until then no change has a known check.`,
      },
    ]
  const names = new Set(registry.entries.map((entry) => entry.name))
  return [
    ...registry.unusable.map(({ index, message }) => ({
      kind: 'unusable-entry' as const,
      message: `scenarios[${index}] ${message}`,
    })),
    ...registry.entries
      .filter((entry) => entry.problem)
      .map((entry) => ({
        kind: 'invalid-entry' as const,
        entry: entry.name,
        files: filesOf(found, entry.name),
        message: `${entry.name} cannot be planned: ${entry.problem}`,
      })),
    ...stale.map(({ entry, pattern }) => ({
      kind: 'stale-pattern' as const,
      entry,
      message: `${entry} lists ${pattern}, which matches no file: was it moved or renamed?`,
    })),
    ...Object.keys(expectations)
      .filter((name) => !names.has(name))
      .map((name) => ({
        kind: 'unknown-entry' as const,
        entry: name,
        message: `An expectation was given for ${name}, which the registry does not list`,
      })),
  ]
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

/** What the changed files need, by scenario name: questions, missing expectations, scenarios for suspects. */
function changeRequests(input: GapInput, uncovered: string[]): InputRequest[] {
  const { registry, found, suspects, expectations } = input
  const requests: InputRequest[] = []
  for (const entry of [...(registry?.entries ?? [])].sort(byName)) {
    const files = filesOf(found, entry.name)
    if (!files.length || entry.problem) continue
    if (entry.question)
      requests.push({
        kind: 'question',
        entry: entry.name,
        files,
        message: entry.question,
      })
    if (entry.check && !entry.expectation && !expectations[entry.name])
      requests.push({
        kind: 'missing-expectation',
        entry: entry.name,
        files,
        message: `${entry.name} has no stated expectation: say what the product should do and where that comes from, in the registry or for this plan, before relying on it`,
      })
  }
  for (const suspect of suspects.filter((s) => uncovered.includes(s.file)))
    requests.push({
      kind: 'scenario-needed',
      files: [suspect.file],
      message: `${suspect.pattern} at ${suspect.file}:${suspect.line}${suspect.read ? ` (read: ${suspect.read})` : ''} has no registered scenario. ${suspect.check}`,
    })
  return requests
}

/** The changed files nothing concerns, and every request for input, in a stable order. */
export function gapsOf(input: GapInput) {
  const concerned = new Set([
    ...input.found.map((s) => s.file),
    ...input.suggestions.map((s) => s.file),
  ])
  const uncovered = input.changes.filter(
    (change) => !concerned.has(change.path),
  )
  const needsInput = [
    ...registryRequests(input),
    ...changeRequests(
      input,
      uncovered.map((change) => change.path),
    ),
    ...selfCheckRequests(input),
    ...(input.planned > 20
      ? [
          {
            kind: 'too-many-checks' as const,
            message: `${input.planned} checks were selected; a verify plan holds 20. Split the change or narrow the registry.`,
          },
        ]
      : []),
  ]
  return {
    uncovered: uncovered.map((change) => ({
      ...change,
      suspects: input.suspects.filter((s) => s.file === change.path),
    })),
    needsInput,
  }
}
