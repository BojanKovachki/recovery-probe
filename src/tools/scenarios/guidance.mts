import type { Problem } from '../../reports/evidence.mjs'
import type { Preflight } from './preflight.mjs'

/** One run of a scenario, as the self-check reports it. */
export interface SelfCheckRun {
  run: number
  exitCode: number | null
  /** The run's report.json, relative to the working directory. */
  report?: string
  complete?: boolean
  gaps: string[]
  problems: Problem[]
  /** How each CONTENT_BEFORE_READ came about, from the report's findings. */
  contentBeforeRead?: string[]
  /** Why the run failed: the error its report records, or why it wrote none. */
  error?: string
}

/** A problem or gap some runs had and others did not. */
export interface RunDifference {
  kind: 'problem' | 'gap'
  code: string
  presentIn: number[]
  absentIn: number[]
}

// What a coverage gap means or can mean; matched by the code inside the gap text.
const GAP_HINTS: [string, string][] = [
  [
    'capture complete',
    'the capture ran to its end, with the coverage gaps listed with it',
  ],
  [
    'CONTENT_MARKER_NOT_OBSERVED',
    'no sample saw the content marker: the screen may not have been open, the selector may not match it, the content may never have loaded, or it may have been on screen for less than one sampling interval (wait in the steps before changing it)',
  ],
  [
    'HIDDEN_DOCUMENT',
    'the page was hidden or minimized during the capture: keep the window visible, or set restoreWindow',
  ],
  [
    'OPERATOR_STEPS_INCOMPLETE',
    'the scripted steps did not finish: a step may have waited in vain, or the capture ended first',
  ],
  [
    'FAULT_NOT_TRIGGERED',
    'the injected fault never matched a request: the endpoint or channel may not be the read the screen makes',
  ],
  [
    'BASELINE_FAILED',
    'the healthy baseline did not pass: the ready marker or the read may not match the screen',
  ],
  [
    'PROGRESS_NOT_OBSERVED',
    'no row showed a readable progress value: compare rows.progress with the screen',
  ],
]

const runList = (runs: number[]) => runs.join(', ')

/** A problem as runs are compared: its code, and the fault or scenario it was found under. */
export const problemKey = ({ code, scope }: Problem) =>
  scope ? `${code} (${scope})` : code

/** CONTENT_BEFORE_READ: what each basis allows as a cause, without claiming one. */
const CONTENT_BEFORE_READ: Record<string, string> = {
  NO_READ_OBSERVED_IN_INTERVAL:
    'CONTENT_BEFORE_READ: content was on screen while the configured read never happened in that interval. This can mean the capture begins after the content loaded, or that the configured endpoint or channel is not the read that draws the content marker. Investigate both; the finding does not show which applies.',
  NO_COMPLETION_OBSERVED_IN_INTERVAL:
    'CONTENT_BEFORE_READ: content was on screen before the configured read completed. This can mean the content comes from a cache or an earlier read, or that the capture begins after the content loaded. Investigate before relying on the scenario; the finding does not show which applies.',
}

export function preflightGuidance({ errors, unresolved }: Preflight) {
  return [
    ...(errors.length
      ? ['Nothing was run: fix the configuration problems above first.']
      : []),
    ...(unresolved.length
      ? [
          'Fill in the unresolved values with the real ones before running the scenario.',
        ]
      : []),
  ]
}

export function executionGuidance(runs: SelfCheckRun[], requires: string[]) {
  const errors = [...new Set(runs.flatMap((run) => run.error ?? []))]
  return [
    ...errors.map((error) => {
      const where = runs.filter((run) => run.error === error)
      return `Run(s) ${runList(where.map((run) => run.run))} failed: ${error}`
    }),
    `${requires.length ? `It needs ${requires.join('; ')}. ` : ''}Start what is missing or correct the address, then run the self-check again.`,
  ]
}

export function gapGuidance(runs: SelfCheckRun[]) {
  const gaps = [...new Set(runs.flatMap((run) => run.gaps))]
  return gaps.map((gap) => {
    const hint = GAP_HINTS.find(([code]) => gap.includes(code))?.[1]
    const where = runs
      .filter((run) => run.gaps.includes(gap))
      .map((run) => run.run)
    return `Incomplete in run(s) ${runList(where)} (${gap})${hint ? `: ${hint}` : ''}. An incomplete run cannot count as evidence.`
  })
}

export function differenceGuidance(differences: RunDifference[]) {
  return [
    ...differences.map(
      (d) =>
        `${d.code} appeared in run(s) ${runList(d.presentIn)} but not in ${runList(d.absentIn)}.`,
    ),
    'A result that changes between runs of the same build cannot show what a change did. Investigate waits and readiness in the steps, sampling against fast changes, and nondeterminism in the app or its data; the run reports show what differed.',
  ]
}

export function findingGuidance(runs: SelfCheckRun[]) {
  const problems = new Map(
    runs.flatMap((run) => run.problems.map((p) => [problemKey(p), p])),
  )
  const bases = new Set(runs.flatMap((run) => run.contentBeforeRead ?? []))
  return [...problems].flatMap(([key, problem]) => {
    if (problem.severity === 'defect')
      return [
        `${key}, a suspected defect, on every run of the build you declared as the reference. If that build is meant to be correct, check the scenario's expectation against it; if it really has this defect, the scenario shows it there.`,
      ]
    const lead = `${key}, a lead, on every run of the reference build. Verify counts a problem left on both sides against VERIFIED, so if the build is correct this scenario cannot verify a fix until the lead goes away.`
    if (problem.code !== 'CONTENT_BEFORE_READ') return [lead]
    return [
      lead,
      ...[...bases].map(
        (basis) =>
          CONTENT_BEFORE_READ[basis] ?? `CONTENT_BEFORE_READ (${basis}).`,
      ),
    ]
  })
}

export const cleanGuidance = (runs: number) => [
  `Complete and consistent over ${runs} run(s), with no findings, on the build you declared as the reference. This does not show that the app is correct, that the scenario detects the defect it is meant for, or that any change is verified. To see whether it detects its defect, self-check it on a build that has the defect.`,
]
