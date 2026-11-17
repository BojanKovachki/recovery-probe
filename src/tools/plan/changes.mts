import { relative, resolve, sep } from 'node:path'
import {
  changedLines,
  git,
  gitPaths,
  repositoryRoot,
  untrackedFiles,
} from '../suspects/files.mjs'

/** A mistake in what the planner was given, such as a reference Git does not know. */
export class PlanInputError extends Error {}

export type ChangeStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** A file that differs between the base and the working tree. */
export interface ChangedFile {
  /** Relative to the repository root, with forward slashes; a deleted file's old path. */
  path: string
  status: ChangeStatus
  /** A renamed file's path at the base. */
  previousPath?: string
  /** The added or changed lines, such as "3-5, 9"; "all" for a new file. */
  lines?: string
}

export interface ChangeSet {
  root: string
  /** The commit `ref` names. */
  commit: string
  changes: ChangedFile[]
}

const STATUS: Record<string, ChangeStatus> = {
  A: 'added',
  C: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'modified',
  U: 'modified',
}

/** The commit `ref` names, or why it can't be used. */
async function commitOf(cwd: string, ref: string): Promise<string> {
  if (!/^[^\s-][^\s]{0,200}$/.test(ref) || ref.includes('..'))
    throw new PlanInputError(
      `"${ref}" is not a Git reference: use a branch, tag or commit, such as main`,
    )
  try {
    const [commit] = await git(cwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ])
    return commit
  } catch {
    throw new PlanInputError(
      `Git does not know the reference "${ref}" here: use a branch, tag or commit that exists (git branch -a lists them; fetch it first if it is only on a remote)`,
    )
  }
}

/** Status lines from `git diff --name-status -z`: status, path, and a second path for a rename or copy. */
function parseNameStatus(fields: string[]): ChangedFile[] {
  const changes: ChangedFile[] = []
  for (let i = 0; i < fields.length;) {
    const status = STATUS[fields[i][0]] ?? 'modified'
    if (fields[i][0] === 'R' || fields[i][0] === 'C') {
      const [previousPath, path] = [fields[i + 1], fields[i + 2]]
      changes.push(
        status === 'renamed'
          ? { path, status, previousPath }
          : { path, status: 'added' },
      )
      i += 3
    } else {
      changes.push({ path: fields[i + 1], status })
      i += 2
    }
  }
  return changes
}

/** "3-5, 9" for lines 3, 4, 5 and 9. */
function ranges(lines: Set<number>): string {
  const sorted = [...lines].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let end = i
    while (sorted[end + 1] === sorted[end] + 1) end++
    parts.push(end > i ? `${sorted[i]}-${sorted[end]}` : String(sorted[i]))
    i = end
  }
  return parts.join(', ')
}

/**
 * Every file that differs between `ref` and the working tree: committed, staged and unstaged
 * changes alike, untracked files, deletions and renames. Files in `ignored` (absolute paths)
 * are left out.
 */
export async function changesSince(
  ref: string,
  {
    cwd = process.cwd(),
    ignored = [],
  }: { cwd?: string; ignored?: string[] } = {},
): Promise<ChangeSet> {
  let root: string
  try {
    root = await repositoryRoot(cwd)
  } catch {
    throw new PlanInputError(
      'Not in a Git repository: run the planner from the project working tree',
    )
  }
  const commit = await commitOf(cwd, ref)
  const changes = parseNameStatus(
    await gitPaths(cwd, ['diff', '--name-status', '-M', commit]),
  )
  for (const path of await untrackedFiles(cwd))
    changes.push({ path, status: 'untracked' })
  const lines = await changedLines(commit, { cwd })
  const relativeLines = new Map(
    [...lines].map(([path, set]) => [
      relative(root, path).split(sep).join('/'),
      set,
    ]),
  )
  const kept = changes
    .filter((change) => !ignored.includes(resolve(root, change.path)))
    .map((change) => {
      const changed = relativeLines.get(change.path)
      if (change.status === 'deleted' || !changed) return change
      return { ...change, lines: changed === true ? 'all' : ranges(changed) }
    })
  kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { root, commit, changes: kept }
}
