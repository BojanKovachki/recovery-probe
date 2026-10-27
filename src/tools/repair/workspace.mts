import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { promisify } from 'node:util'
import { ensure } from '../../core/validate.mjs'
import type { RepairConfig } from './config.mjs'
import { runCommand, type CommandResult } from './process.mjs'

export type CommandRecord = CommandResult & { command: string[] }

const exec = promisify(execFile)

export const git = async (cwd: string, args: string[]) =>
  (
    await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      maxBuffer: 4000000,
      timeout: 30000,
    })
  ).stdout

export const sha = (value: string) =>
  createHash('sha256').update(value).digest('hex')

export const save = (directory: string, name: string, value: unknown) =>
  writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  })

// Resolve existing ancestor symlinks before creating anything near the source tree.
async function canonicalDestination(path: string) {
  let ancestor = dirname(resolve(path))
  const missing = [basename(path)]
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...missing)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        ancestor === dirname(ancestor)
      )
        throw error
      missing.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
}

/** The repository root, clean and committed. */
async function cleanRepository(path: string) {
  const repo = await realpath(path)
  ensure(
    (await realpath(
      (await git(repo, ['rev-parse', '--show-toplevel'])).trim(),
    )) === repo,
    'repo must be the repository root',
  )
  ensure(
    !(
      await git(repo, ['status', '--porcelain', '--untracked-files=normal'])
    ).trim(),
    'Commit or stash your changes first; repair starts from a clean committed repository',
  )
  return repo
}

/** A new run folder outside the repository; an existing one is never reused. */
async function runFolder(repo: string, directory: string) {
  const dir = await canonicalDestination(directory)
  const rel = relative(repo, dir)
  ensure(
    isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`),
    'Repair output must be outside the source repository',
  )
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 })
  return dir
}

/** Clones the repository's HEAD into `<run>/checkout`, detached and without a remote. */
export async function prepareWorkspace(repoPath: string, directory: string) {
  const repo = await cleanRepository(repoPath)
  const dir = await runFolder(repo, directory)
  const baseCommit = (await git(repo, ['rev-parse', 'HEAD'])).trim()
  const workspace = join(dir, 'checkout')
  // Check out the committed bytes, whatever this machine's Git converts. Git for Windows
  // writes CRLF by default, and a model's multi-line edit with LF breaks would not match.
  // Explicit eol attributes in .gitattributes still apply.
  await git(dir, [
    'clone',
    '--local',
    '--no-hardlinks',
    '--no-checkout',
    '--config',
    'core.autocrlf=false',
    '--config',
    'core.eol=lf',
    '--',
    repo,
    workspace,
  ])
  await git(workspace, ['checkout', '--detach', baseCommit])
  await git(workspace, ['remote', 'remove', 'origin']) // No accidental push target.
  return { dir, baseCommit, workspace }
}

export async function assertTrackedUnchanged(workspace: string) {
  ensure(
    !(
      await git(workspace, ['status', '--porcelain', '--untracked-files=no'])
    ).trim(),
    'Setup, tests or app changed tracked files; refusing unverifiable baseline',
  )
}

/** Runs the configured setup or test commands in order, stopping at the first failure. */
export async function runCommands(
  config: RepairConfig,
  workspace: string,
  key: 'setup' | 'tests',
) {
  const results: CommandRecord[] = []
  for (const command of config[key] ?? []) {
    const result = await runCommand(command, workspace, config.commandTimeoutMs)
    results.push({ command, ...result })
    if (result.code !== 0) break
  }
  return results
}
