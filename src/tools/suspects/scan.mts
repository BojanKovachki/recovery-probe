import { relative, resolve, sep } from 'node:path'
import { changedLines, changedSourceFiles, sourceFiles } from './files.mjs'
import { findSuspects, type Suspect } from './source.mjs'

export interface SuspectScan {
  /** How many source files were read. */
  scanned: number
  /** File names are relative to the working directory, with forward slashes. */
  suspects: Suspect[]
}

interface ScanOptions {
  paths?: string[]
  changedSince?: string
  changedLinesOnly?: boolean
  includeTests?: boolean
}

/** The files to scan: the given paths, or the files changed since a reference under them. */
async function filesToScan({
  paths = [],
  changedSince,
  includeTests = false,
}: ScanOptions) {
  if (!changedSince)
    return sourceFiles(paths.length ? paths : ['.'], { includeTests })
  const changed = await changedSourceFiles(changedSince, { includeTests })
  if (!paths.length) return changed
  const wanted = new Set(
    (await sourceFiles(paths, { includeTests })).map((path) => resolve(path)),
  )
  return changed.filter((path) => wanted.has(resolve(path)))
}

/**
 * Scans the given files and directories (default: the working directory), or
 * only the files changed since `changedSince`; with both, the changed files
 * under the given paths. `changedLinesOnly` also leaves out suspects on lines
 * the change did not touch.
 */
export async function scanForSuspects(
  options: ScanOptions = {},
): Promise<SuspectScan> {
  const { changedSince, changedLinesOnly = false } = options
  if (changedLinesOnly && !changedSince)
    throw new Error('changedLinesOnly needs changedSince')
  const files = await filesToScan(options)
  let found = await findSuspects(files)
  if (changedLinesOnly) {
    const changed = await changedLines(changedSince!)
    found = found.filter((suspect) => {
      const lines = changed.get(resolve(suspect.file))
      return lines === true || lines?.has(suspect.line)
    })
  }
  const suspects = found.map((suspect) => ({
    ...suspect,
    file: relative('.', suspect.file).split(sep).join('/'),
  }))
  return { scanned: files.length, suspects }
}
