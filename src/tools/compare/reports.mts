import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  EVIDENCE_SCHEMA,
  evidenceOf,
  kindOf,
  type Evidence,
} from '../../reports/evidence.mjs'
import type { RunEvidence } from './types.mjs'

type Report = Record<string, unknown>

const string = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined

/**
 * The report files a path stands for: the file itself, the report.json in a
 * report folder, or those in the folders inside it (one folder per run).
 */
export async function reportFiles(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path]
  if (existsSync(join(path, 'report.json'))) return [join(path, 'report.json')]
  const runs = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name, 'report.json'))
    .filter((file) => existsSync(file))
    .sort()
  if (!runs.length)
    throw new Error(`No report.json in ${path} or in the folders inside it`)
  return runs
}

/** Reads one report file. */
export async function readRunEvidence(file: string): Promise<RunEvidence> {
  let report: Report
  try {
    report = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, {
      cause: error,
    })
  }
  return runEvidence(report, file)
}

/** Reduces a parsed report to what can be compared. */
export function runEvidence(report: Report, path = ''): RunEvidence {
  const kind = kindOf(report)
  const mode = string(report?.mode)
  if (!kind)
    throw new Error(
      `${path || 'This file'} is not a Recovery Probe report this version can compare${mode ? ` (mode: ${mode})` : ''}`,
    )
  // Reports carry their evidence; older ones are read from their fields.
  const embedded = report.evidence as Evidence | undefined
  const { schema: _schema, ...evidence } =
    embedded?.schema === EVIDENCE_SCHEMA ? embedded : evidenceOf(report, kind)
  const coverage = report.coverage as Record<string, unknown> | undefined
  return {
    ...evidence,
    path,
    mode: mode ?? kind.workflow,
    limitation: string(report.limitation) ?? string(coverage?.scope),
  }
}
