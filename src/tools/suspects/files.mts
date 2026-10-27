import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const SOURCE = /\.[cm]?[jt]sx?$/
const DECLARATION = /\.d\.[cm]?ts$/
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  '.recovery-probe',
])
const TEST_FILE =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])(?:__tests__|__mocks__)[\\/]/

export const isScannable = (path: string, includeTests: boolean) =>
  SOURCE.test(path) &&
  !DECLARATION.test(path) &&
  (includeTests || !TEST_FILE.test(path))

/** The source files under the given files and directories. */
export async function sourceFiles(
  paths: string[],
  { includeTests = false }: { includeTests?: boolean } = {},
): Promise<string[]> {
  const files: string[] = []
  const walk = async (path: string) => {
    if ((await stat(path)).isFile()) {
      if (isScannable(path, includeTests)) files.push(path)
      return
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name))
          await walk(join(path, entry.name))
      } else if (
        entry.isFile() &&
        isScannable(join(path, entry.name), includeTests)
      )
        files.push(join(path, entry.name))
    }
  }
  for (const path of paths) await walk(path)
  return files
}

const git = (cwd: string, args: string[]) =>
  promisify(execFile)('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout }) => stdout.split('\n').filter(Boolean),
  )

const untrackedFiles = (cwd: string) =>
  git(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name'])

// Relative to cwd, so paths keep its spelling, such as a Windows short name.
const repositoryRoot = async (cwd: string) =>
  resolve(cwd, (await git(cwd, ['rev-parse', '--show-cdup']))[0] ?? '')

/** Source files changed since `ref` in the Git work tree around `cwd`, including uncommitted and untracked ones. */
export async function changedSourceFiles(
  ref: string,
  {
    cwd = process.cwd(),
    includeTests = false,
  }: { cwd?: string; includeTests?: boolean } = {},
): Promise<string[]> {
  const root = await repositoryRoot(cwd)
  const changed = new Set([
    ...(await git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', ref])),
    ...(await untrackedFiles(cwd)),
  ])
  return [...changed]
    .map((path) => resolve(root, path))
    .filter((path) => isScannable(path, includeTests) && existsSync(path))
}

/** The added and changed lines of a zero-context diff, by absolute path. */
function diffLines(diff: string[], root: string) {
  const changed = new Map<string, Set<number> | true>()
  let lines: Set<number> | undefined
  // "+++ " names the file only in a file header, never in a hunk.
  let inHeader = false
  for (const line of diff) {
    if (line.startsWith('diff --git ')) inHeader = true
    else if (inHeader && line.startsWith('+++ b/')) {
      lines = new Set()
      changed.set(resolve(root, line.slice('+++ b/'.length)), lines)
    } else if (line.startsWith('@@ ')) {
      inHeader = false
      const [, start, count = '1'] =
        /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line) ?? []
      for (let n = Number(start); n < Number(start) + Number(count); n++)
        lines?.add(n)
    }
  }
  return changed
}

/**
 * The lines added or changed since `ref`, by absolute path, including
 * uncommitted changes. `true` stands for an untracked file, new as a whole.
 */
export async function changedLines(
  ref: string,
  { cwd = process.cwd() }: { cwd?: string } = {},
): Promise<Map<string, Set<number> | true>> {
  const root = await repositoryRoot(cwd)
  const diff = await git(cwd, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--diff-filter=ACMR',
    ref,
  ])
  const changed = diffLines(diff, root)
  for (const path of await untrackedFiles(cwd))
    changed.set(resolve(root, path), true)
  return changed
}
