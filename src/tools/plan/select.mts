import { readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { escapeRegExp } from '../../core/regexp.mjs'
import { git } from '../suspects/files.mjs'
import type { ChangedFile } from './changes.mjs'
import type { RegistryEntry } from './registry.mjs'

/** Why a registry entry concerns a changed file. */
export interface Selection {
  file: string
  entry: string
  pattern: string
  /** The pattern matched the path the file had at the base, before a rename. */
  previousPath?: true
}

/** A changed file a scenario's file imports, though no entry lists it: worth reviewing, not planned. */
export interface Suggestion {
  file: string
  entry: string
  importedBy: string
}

/** `*` matches within a folder, `**` across folders, `?` one character. */
export function globRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 2
    } else if (pattern.startsWith('**', i)) {
      source += '.*'
      i += 1
    } else if (pattern[i] === '*') source += '[^/]*'
    else if (pattern[i] === '?') source += '[^/]'
    else source += escapeRegExp(pattern[i])
  }
  return new RegExp(`^${source}$`)
}

const matcher = (entry: RegistryEntry) =>
  entry.paths.map((pattern) => ({ pattern, regexp: globRegExp(pattern) }))

/** Every entry whose paths match a changed file, at its current path or, for a rename, its old one. */
export function selections(
  changes: ChangedFile[],
  entries: RegistryEntry[],
): Selection[] {
  const found: Selection[] = []
  for (const entry of entries)
    for (const { pattern, regexp } of matcher(entry))
      for (const change of changes) {
        const atPath = regexp.test(change.path)
        if (
          !atPath &&
          !(change.previousPath && regexp.test(change.previousPath))
        )
          continue
        if (found.some((s) => s.file === change.path && s.entry === entry.name))
          continue
        found.push({
          file: change.path,
          entry: entry.name,
          pattern,
          ...(atPath ? {} : { previousPath: true as const }),
        })
      }
  return found
}

const SOURCE = /\.[cm]?[jt]sx?$/
const EXTENSIONS = [
  '',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.mts',
  '.cts',
]
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"\n]+)['"]/gm

/** The repository files a relative import specifier in `file` can name. */
function importedPaths(file: string, text: string): Set<string> {
  const paths = new Set<string>()
  for (const [, specifier] of text.matchAll(RELATIVE_IMPORT)) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier))
    for (const extension of EXTENSIONS) {
      paths.add(target + extension)
      if (extension) paths.add(`${target}/index${extension}`)
    }
  }
  return paths
}

/** The source files an entry lists, read as text; large and missing files are skipped. */
async function listedSources(
  root: string,
  entry: RegistryEntry,
  files: string[],
) {
  const patterns = matcher(entry)
  const listed = files
    .filter((file) => SOURCE.test(file))
    .filter((file) => patterns.some(({ regexp }) => regexp.test(file)))
    .slice(0, 200)
  const sources: { file: string; text: string }[] = []
  for (const file of listed) {
    const path = join(root, file)
    const size = await stat(path).then(
      (s) => s.size,
      () => Infinity,
    )
    if (size <= 200_000)
      sources.push({ file, text: await readFile(path, 'utf8') })
  }
  return sources
}

/**
 * For each changed file no entry lists, the entries with a check whose listed files import it
 * with a relative specifier. One step only: this points at a scenario to review, it does not
 * prove the scenario exercises the change.
 */
export async function importSuggestions(
  root: string,
  entries: RegistryEntry[],
  unlisted: ChangedFile[],
): Promise<Suggestion[]> {
  if (!unlisted.length) return []
  const files = await git(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
  const wanted = new Map<string, string>()
  for (const change of unlisted) {
    wanted.set(change.path, change.path)
    if (change.previousPath) wanted.set(change.previousPath, change.path)
  }
  const found: Suggestion[] = []
  for (const entry of entries.filter((e) => e.check && !e.problem))
    for (const { file, text } of await listedSources(root, entry, files))
      for (const path of importedPaths(file, text)) {
        const changed = wanted.get(path)
        if (
          changed &&
          !found.some((s) => s.file === changed && s.entry === entry.name)
        )
          found.push({ file: changed, entry: entry.name, importedBy: file })
      }
  return found
}

/** Patterns that match no file in the repository, often left behind by a move or rename. */
export async function stalePatterns(
  root: string,
  entries: RegistryEntry[],
  deleted: string[],
): Promise<{ entry: string; pattern: string }[]> {
  const files = [
    ...(await git(root, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
    ])),
    ...deleted,
  ]
  return entries.flatMap((entry) =>
    matcher(entry)
      .filter(({ regexp }) => !files.some((file) => regexp.test(file)))
      .map(({ pattern }) => ({ entry: entry.name, pattern })),
  )
}
