import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { ensure } from '../../core/validate.mjs'
import type { RepairEdit, RepairProposal } from './provider.mjs'
import { git, sha } from './workspace.mjs'

export interface SourceSnapshot {
  path: string
  content: string
  sha256: string
}

const MAX_FILE = 100000
const MAX_SOURCES = 300000

// Paths come from a JSON config and from a model's proposal, so they are checked at runtime.
export function validateSourcePath(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !/^[a-zA-Z0-9_@./-]+\.(?:[cm]?[jt]sx?|vue|svelte|html|css|rs)$/.test(
      path,
    ) ||
    path
      .split('/')
      .some((part) => !part || part === '..' || part.startsWith('.')) ||
    /(^|\/)(node_modules|vendor|dist|build|tests?|__tests__|fixtures|coverage)(\/|$)|[.-](test|spec|config)\.|(^|\/)(secrets?|credentials?)[./-]/i.test(
      path,
    )
  ) {
    throw new Error(`Not an allowed application source path: ${String(path)}`)
  }
  return path
}

/** A source file's text: a regular, non-symlinked, small text file. */
export async function sourceFile(root: string, path: string) {
  validateSourcePath(path)
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink())
      throw new Error('Source symlinks are not allowed')
  }
  const stat = await lstat(current)
  ensure(
    stat.isFile() && stat.size <= MAX_FILE,
    'Each source must be a regular file of at most 100 KB',
  )
  const content = await readFile(current, 'utf8')
  ensure(!content.includes('\0'), 'Binary source is not allowed')
  return content
}

/** The selected sources as checked out, with their hashes. */
export async function snapshotSources(
  workspace: string,
  paths: string[],
): Promise<SourceSnapshot[]> {
  const sources: SourceSnapshot[] = []
  for (const path of paths) {
    // The index says what a path is. Without symlink rights, Git for Windows checks out
    // a committed symlink as a plain file holding the link text.
    const [mode] = (
      await git(workspace, [
        'ls-files',
        '--stage',
        '--error-unmatch',
        '--',
        path,
      ])
    ).split(' ')
    ensure(mode !== '120000', 'Source symlinks are not allowed')
    const content = await sourceFile(workspace, path)
    sources.push({ path, content, sha256: sha(content) })
  }
  ensure(
    sources.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <=
      MAX_SOURCES,
    'Selected sources exceed the 300 KB context limit',
  )
  return sources
}

function checkProposal(proposal: unknown): RepairEdit[] {
  const candidate = proposal as Partial<RepairProposal> | null | undefined
  ensure(
    candidate &&
      typeof candidate.summary === 'string' &&
      typeof candidate.reasoning === 'string' &&
      Array.isArray(candidate.edits) &&
      candidate.edits.length <= 12,
    'Invalid patch proposal',
  )
  return candidate.edits as RepairEdit[]
}

function applyEdit(modified: Map<string, string>, edit: Partial<RepairEdit>) {
  validateSourcePath(edit.path)
  ensure(
    modified.has(edit.path as string) &&
      typeof edit.find === 'string' &&
      edit.find &&
      typeof edit.replace === 'string' &&
      edit.replace.length <= MAX_FILE &&
      edit.find !== edit.replace,
    'Patch edit must change only an allowlisted source file',
  )
  const path = edit.path as string
  const original = modified.get(path) as string
  const index = original.indexOf(edit.find)
  ensure(
    index >= 0 && original.indexOf(edit.find, index + 1) === -1,
    'Patch find text must match exactly once; no fuzzy application',
  )
  const result =
    original.slice(0, index) +
    edit.replace +
    original.slice(index + edit.find.length)
  ensure(
    Buffer.byteLength(result) <= MAX_FILE,
    'Patched source exceeds the size limit',
  )
  modified.set(path, result)
}

// A proposal comes from a model, so every field is checked before it touches a file.
export function applyProposalToSources(
  proposal: unknown,
  sources: { path: string; content: string }[],
): Map<string, string> {
  const edits = checkProposal(proposal)
  const modified = new Map(
    sources.map((source) => [source.path, source.content]),
  )
  for (const edit of edits) applyEdit(modified, edit)
  return modified
}
