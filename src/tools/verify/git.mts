import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { commitOf } from '../plan/changes.mjs'
import { repositoryRoot } from '../suspects/files.mjs'
import type { BaseProvenance, Revisions } from './types.mjs'

const run = promisify(execFile)

/** What a Git command prints, trimmed. */
async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const { stdout } = await run('git', args, {
    cwd,
    env: env && { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.trim()
}

/**
 * A file's committed bytes in a commit or tree, or null when it has none. Committed bytes,
 * not the working copy's, so line-ending conversion never changes a hash.
 */
export async function blobAt(
  root: string,
  treeish: string,
  path: string,
): Promise<Buffer | null> {
  try {
    const { stdout } = await run(
      'git',
      ['cat-file', 'blob', `${treeish}:${path}`],
      { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    )
    return stdout
  } catch {
    return null
  }
}

/**
 * The tree Git would commit for the working tree, untracked files included and ignored ones
 * left out. It goes through a temporary index, so the user's index and branch stay as they were.
 */
export async function snapshotTree(root: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'recovery-probe-snapshot-'))
  const env = { GIT_INDEX_FILE: join(folder, 'index') }
  try {
    if (await headOf(root)) await git(root, ['read-tree', 'HEAD'], env)
    await git(root, ['add', '-A', '--', '.'], env)
    return await git(root, ['write-tree'], env)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

const headOf = (root: string) =>
  git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => null)

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Recovery Probe',
  GIT_AUTHOR_EMAIL: 'recovery-probe@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Recovery Probe',
  GIT_COMMITTER_EMAIL: 'recovery-probe@localhost',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
}

/**
 * A commit of `tree` on top of `head` that no ref points to, so the candidate can be checked
 * out on its own. Its fixed author and date make the same tree on the same parent the same
 * commit. It's never signed: it's a throwaway object that never leaves the machine.
 */
export const snapshotCommit = (
  root: string,
  tree: string,
  head: string | null,
) =>
  git(
    root,
    [
      'commit-tree',
      '--no-gpg-sign',
      tree,
      ...(head ? ['-p', head] : []),
      '-m',
      'Recovery Probe snapshot of the working tree',
    ],
    SNAPSHOT_IDENTITY,
  )

/** The base and the candidate's working tree. Plan mode records what it can, and null for the rest. */
export async function revisionsOf(
  cwd: string,
  baseRef: string,
): Promise<{ root: string | null; revisions: Revisions }> {
  const root = await repositoryRoot(cwd).catch(() => null)
  const revisions: Revisions = {
    base: { ref: baseRef, commit: null },
    candidate: { head: null, snapshotTree: null, uncommittedChanges: null },
  }
  if (!root) return { root, revisions }
  revisions.base.commit = await commitOf(root, baseRef).catch(() => null)
  const head = await headOf(root)
  const tree = await snapshotTree(root).catch(() => null)
  const headTree = head && (await git(root, ['rev-parse', `${head}^{tree}`]))
  revisions.candidate = {
    head,
    snapshotTree: tree,
    uncommittedChanges: tree === null ? null : tree !== headTree,
  }
  return { root, revisions }
}

/** The remote branch of the same name: the ref's upstream, or origin's branch of that name. */
async function remoteTracking(root: string, ref: string) {
  const upstream = await git(root, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${ref}@{upstream}`,
  ]).catch(() => '')
  for (const candidate of [upstream, `origin/${ref}`, ref].filter(Boolean)) {
    const exists = await git(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${candidate}`,
    ]).catch(() => '')
    if (exists) return { name: candidate, commit: exists }
  }
  return null
}

const NOTE =
  "Recovery Probe can't tell whether the base was protected or reviewed."

/** Where the base came from; never proof that anyone reviewed it. */
export async function baseProvenance(
  root: string,
  ref: string,
  commit: string,
): Promise<BaseProvenance> {
  const suppliedBy = process.env.CI ? 'ci' : 'local'
  const remote = await remoteTracking(root, ref)
  let result: BaseProvenance['onRemoteTracking']['result'] = 'no-remote-branch'
  if (remote?.commit === commit) result = 'equal'
  else if (remote)
    result = await git(root, [
      'merge-base',
      '--is-ancestor',
      commit,
      remote.commit,
    ]).then(
      () => 'ancestor' as const,
      () => 'not-on-remote' as const,
    )
  return {
    ref,
    commit,
    suppliedBy,
    onRemoteTracking: { ref: remote?.name ?? null, result },
    note:
      suppliedBy === 'ci'
        ? `The base commit was supplied in CI. ${NOTE}`
        : `Criteria came from a local checkout. ${NOTE}`,
  }
}

/** A local base that isn't on its remote branch can't stand for the reviewed one. */
export const baseGaps = (provenance: BaseProvenance) =>
  provenance.suppliedBy === 'local' &&
  !['equal', 'ancestor'].includes(provenance.onRemoteTracking.result)
    ? ['BASE_NOT_ON_REMOTE']
    : []
