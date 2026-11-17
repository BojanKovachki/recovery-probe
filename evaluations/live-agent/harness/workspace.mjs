// An attempt's workspace: the task's starting code, its issue and, for condition B, the prepared
// Recovery Probe scenarios. Nothing else of the evaluation is written into it.
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

// A tree is a set of files as { 'relative/path': Buffer }.

/** Every file under `directory`, skipping folders named in `skip`. */
export async function readTree(directory, skip = ['node_modules']) {
  const tree = {}
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = relative(directory, join(entry.parentPath, entry.name))
    const parts = path.split(sep)
    if (parts.some((part) => skip.includes(part))) continue
    tree[parts.join('/')] = await readFile(join(entry.parentPath, entry.name))
  }
  return tree
}

export async function writeTree(directory, tree) {
  for (const [path, content] of Object.entries(tree)) {
    const file = join(directory, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

/** Files under `prefix/`, with the prefix removed. */
export function subtree(tree, prefix) {
  const start = `${prefix}/`
  return Object.fromEntries(
    Object.entries(tree)
      .filter(([path]) => path.startsWith(start))
      .map(([path, content]) => [path.slice(start.length), content]),
  )
}

// Reports, screenshots and dependencies stay out of the diff an attempt is graded on.
const GITIGNORE = [
  'node_modules/',
  '.recovery-probe/',
  'test-results/',
  'playwright-report/',
  '*.png',
  '*.jpg',
  '*.webm',
  '*.log',
  '',
].join('\n')

/**
 * The files an attempt starts from: the reference app with the task's overlay, the issue, and
 * the condition's extra files.
 */
export function startTree({ app, overlay = {}, issue, extra = {} }) {
  return {
    ...app,
    ...overlay,
    'ISSUE.md': issue,
    '.gitignore': Buffer.from(GITIGNORE),
    ...extra,
  }
}

// A fixed identity and time make every build of the same files the same commit.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Product team',
  GIT_AUTHOR_EMAIL: 'team@example.invalid',
  GIT_AUTHOR_DATE: '2026-11-02T08:00:00+00:00',
  GIT_COMMITTER_NAME: 'Product team',
  GIT_COMMITTER_EMAIL: 'team@example.invalid',
  GIT_COMMITTER_DATE: '2026-11-02T08:00:00+00:00',
}

export function git(directory, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.safecrlf=false',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd: directory,
      env: { ...process.env, ...GIT_ENV },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
}

/** Writes `tree` to the new `directory` and commits it; returns the start commit. */
export async function createWorkspace(directory, tree) {
  await mkdir(directory, { recursive: true })
  await writeTree(directory, tree)
  git(directory, 'init', '-q', '-b', 'main')
  git(directory, 'add', '-A')
  git(directory, 'commit', '-q', '-m', 'Start')
  return git(directory, 'rev-parse', 'HEAD').trim()
}

/** Every change since `start`, committed or not, as a binary diff, and the paths it touches. */
export function finalChanges(directory, start) {
  git(directory, 'add', '-A')
  return {
    diff: git(directory, 'diff', '--cached', '--binary', start),
    paths: git(directory, 'diff', '--cached', '--name-only', start)
      .split('\n')
      .filter(Boolean),
  }
}

/** Rebuilds the start of an attempt in `directory` and applies its diff. */
export async function applyChanges(directory, tree, diff) {
  const start = await createWorkspace(directory, tree)
  if (diff.trim()) {
    const patch = join(directory, '.attempt.diff')
    await writeFile(patch, diff)
    git(directory, 'apply', '--binary', '--whitespace=nowarn', '.attempt.diff')
    await rm(patch)
  }
  return start
}
