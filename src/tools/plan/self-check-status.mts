import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SelfCheckReport } from '../scenarios/self-check.mjs'
import type { PlannedCheck } from './plan.mjs'
import type { RegistryEntry } from './registry.mjs'

/** Where the last runtime self-check keeps its report. */
export const SAVED_SELF_CHECK = join(
  '.recovery-probe',
  'self-check',
  'report.json',
)

/** What the last saved self-check said about a scenario. */
export interface SelfCheckStatus {
  outcome: string
  at: string
  /** The reference build the user declared for that self-check. */
  reference: string
  /** Its command, or a file it reads, differs from what that self-check ran. */
  inputsChanged: boolean
}

/** The last runtime self-check report, or null when there is none or it cannot be read. */
export async function readSavedSelfCheck(): Promise<SelfCheckReport | null> {
  if (!existsSync(SAVED_SELF_CHECK)) return null
  try {
    const report = JSON.parse(await readFile(SAVED_SELF_CHECK, 'utf8'))
    return report?.kind === 'scenario-self-check' &&
      report.mode === 'runtime' &&
      Array.isArray(report.scenarios)
      ? (report as SelfCheckReport)
      : null
  } catch {
    return null
  }
}

/**
 * Adds the saved self-check, when there is one, to each planned scenario; returns them by
 * entry so that problems and changes can be reported. Every planned check stays planned.
 */
export function attachSelfChecks(
  checks: PlannedCheck[],
  entries: RegistryEntry[],
  saved: SelfCheckReport | null,
): { entry: string; status: SelfCheckStatus }[] {
  const found: { entry: string; status: SelfCheckStatus }[] = []
  for (const scenario of checks.flatMap((check) => check.scenarios)) {
    const entry = entries.find((e) => e.name === scenario.entry)
    const status = entry && selfCheckStatus(saved, entry)
    if (!status) continue
    scenario.selfCheck = status
    found.push({ entry: scenario.entry, status })
  }
  return found
}

/** The saved self-check of `entry`, compared with its current command and files. */
export function selfCheckStatus(
  saved: SelfCheckReport | null,
  entry: RegistryEntry,
): SelfCheckStatus | undefined {
  const scenario = saved?.scenarios.find((s) => s.name === entry.name)
  if (!saved || !scenario) return undefined
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b)
  return {
    outcome: scenario.outcome,
    at: saved.at,
    reference: saved.reference?.label ?? '',
    inputsChanged:
      !same(scenario.command, entry.check) ||
      !same(scenario.preflight?.inputs, entry.preflight?.inputs ?? []),
  }
}
