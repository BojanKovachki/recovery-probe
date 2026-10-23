import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ObservationReport } from './report.mjs'

export interface FileSnapshot {
  /** Size in bytes of each regular file, by path relative to the directory. */
  files: Map<string, number>
  truncated: boolean
  error?: string
}

export interface FileChanges {
  removed: number
  shrunk: number
  added: number
  grown: number
  /** Bytes the removed and shrunk files no longer hold. */
  bytesLost: number
  removedPaths: string[]
  shrunkPaths: string[]
}

/** What changed on disk during one interval. */
export interface IntervalFileChanges extends Omit<
  FileChanges,
  'removedPaths' | 'shrunkPaths'
> {
  interval: number
  /** A snapshot was truncated or unreadable, so the counts may be partial. */
  incomplete?: true
}

export interface FileEvidence {
  /** Counts only, for the report. */
  intervals: IntervalFileChanges[]
  /** Paths, for the private files.json next to the report. */
  paths: { interval: number; removed: string[]; shrunk: string[] }[]
}

const MAX_FILES = 50_000
const MAX_PATHS = 200
const STAT_CONCURRENCY = 64

/** Sizes of the regular files under `directory`. Symbolic links are not followed. */
export async function snapshotFiles(
  directory: string,
  maxFiles = MAX_FILES,
): Promise<FileSnapshot> {
  const files = new Map<string, number>()
  try {
    const entries = (
      await readdir(directory, { recursive: true, withFileTypes: true })
    ).filter((entry) => entry.isFile())
    const kept = entries.slice(0, maxFiles)
    for (let i = 0; i < kept.length; i += STAT_CONCURRENCY)
      await Promise.all(
        kept.slice(i, i + STAT_CONCURRENCY).map(async (entry) => {
          const path = join(entry.parentPath, entry.name)
          try {
            files.set(
              relative(directory, path).split(sep).join('/'),
              (await lstat(path)).size,
            )
          } catch {
            // Removed while the snapshot was taken.
          }
        }),
      )
    return { files, truncated: entries.length > maxFiles }
  } catch (error) {
    return { files, truncated: false, error: (error as Error).message }
  }
}

export function compareSnapshots(
  before: FileSnapshot,
  after: FileSnapshot,
): FileChanges {
  const changes: FileChanges = {
    removed: 0,
    shrunk: 0,
    added: 0,
    grown: 0,
    bytesLost: 0,
    removedPaths: [],
    shrunkPaths: [],
  }
  for (const [path, size] of before.files) {
    const now = after.files.get(path)
    if (now === undefined) {
      changes.removed += 1
      changes.bytesLost += size
      if (changes.removedPaths.length < MAX_PATHS)
        changes.removedPaths.push(path)
    } else if (now < size) {
      changes.shrunk += 1
      changes.bytesLost += size - now
      if (changes.shrunkPaths.length < MAX_PATHS) changes.shrunkPaths.push(path)
    } else if (now > size) changes.grown += 1
  }
  for (const path of after.files.keys())
    if (!before.files.has(path)) changes.added += 1
  return changes
}

/**
 * Compares the snapshots taken as each interval opened, and the last one, so each
 * interval gets what changed on disk while it was open.
 */
export function fileEvidence(
  snapshots: { interval: number; snapshot: FileSnapshot }[],
): FileEvidence {
  const evidence: FileEvidence = { intervals: [], paths: [] }
  for (let i = 0; i + 1 < snapshots.length; i++) {
    const { interval, snapshot: before } = snapshots[i]
    const after = snapshots[i + 1].snapshot
    const { removedPaths, shrunkPaths, ...counts } = compareSnapshots(
      before,
      after,
    )
    const incomplete =
      before.truncated || after.truncated || before.error || after.error
    evidence.intervals.push({
      interval,
      ...counts,
      ...(incomplete ? { incomplete: true } : {}),
    })
    if (removedPaths.length || shrunkPaths.length)
      evidence.paths.push({
        interval,
        removed: removedPaths,
        shrunk: shrunkPaths,
      })
  }
  return evidence
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`

/**
 * Adds the file counts to an observation report: a `LOCAL_FILES_REMOVED` lead for
 * each interval that lost files, and a coverage gap when a snapshot was partial.
 */
export function applyFileEvidence(
  report: ObservationReport,
  evidence: FileEvidence,
): void {
  report.files = { intervals: evidence.intervals }
  for (const changes of evidence.intervals) {
    if (!changes.removed && !changes.shrunk) continue
    report.findings.push({
      code: 'LOCAL_FILES_REMOVED',
      basis: 'FILE_SNAPSHOTS',
      interval: changes.interval,
      summary: `${changes.removed} file(s) removed and ${changes.shrunk} shrunk on disk (${megabytes(changes.bytesLost)} no longer there).`,
    })
    report.intervals
      .find((interval) => interval.index === changes.interval)
      ?.findings.push('LOCAL_FILES_REMOVED')
  }
  const gaps = report.coverage?.gaps
  if (!gaps) return
  if (
    evidence.intervals.some((changes) => changes.incomplete) &&
    !gaps.includes('FILE_SNAPSHOT_INCOMPLETE')
  )
    gaps.push('FILE_SNAPSHOT_INCOMPLETE')
  report.captureComplete = report.status === 'complete' && gaps.length === 0
}
