import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneAt } from '../repair/workspace.mjs'

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
  const folder = await mkdtemp(join(tmpdir(), 'recovery-probe-verify-'))
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
