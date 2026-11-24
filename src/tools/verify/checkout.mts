import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneAt, git } from '../repair/workspace.mjs'

/**
 * Whether a command changed a tracked file in `checkout`, and if it did, the tracked files put
 * back, so the commands after it run on the checked-out commit.
 */
export async function trackedFilesChanged(checkout: string) {
  const status = await git(checkout, [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ])
  if (!status.trim()) return false
  await git(checkout, ['checkout', '--force', 'HEAD', '--', '.'])
  return true
}

/** The base and the candidate, each in its own disposable checkout outside the repository. */
export interface Checkouts {
  base: string
  candidate: string
  remove(): Promise<void>
}

/** Clones the base commit and the candidate's snapshot commit, as repair clones its checkout. */
export async function checkOutSides(
  root: string,
  commits: { base: string; candidate: string },
): Promise<Checkouts> {
  // Windows can name the temp folder in its 8.3 short form (C:\Users\ABCDEF~1\...). Tools that
  // compare paths, such as Vite, then fail inside it, so checkouts use its long form.
  const folder = await mkdtemp(
    join(await realpath(tmpdir()), 'recovery-probe-verify-'),
  )
  const remove = () =>
    rm(folder, { recursive: true, force: true, maxRetries: 5 })
  try {
    const base = join(folder, 'base')
    const candidate = join(folder, 'candidate')
    await cloneAt(root, commits.base, base)
    await cloneAt(root, commits.candidate, candidate)
    return { base, candidate, remove }
  } catch (error) {
    await remove()
    throw error
  }
}
