// A session's folder, outside the repository and the grading folder: the agent's workspace,
// a local remote the pilot base is pushed to, and the harness's own files, which the agent's
// settings deny it.
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isInside, repository } from './grading.mjs'

const run = promisify(execFile)

/** Git with hooks off and a fixed identity, so a session's setup never runs project code. */
export const git = (cwd, ...args) =>
  run(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Recovery Probe pilot',
      '-c',
      'user.email=pilot@localhost',
      ...args,
    ],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  )

/** A permission rule's path for everything under `folder`: `//c/Users/x/**` for C:\Users\x. */
export const everythingUnder = (folder) =>
  `//${folder
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/, (_, drive) => drive.toLowerCase())
    .replace(/^\/+|\/+$/g, '')}/**`

const ARM_TEXT = {
  A: 'Before you say the change is done, run the checks listed in VERIFY.md: the project checks, and the application and failure-path checks for each claim, with Playwright. Say done only when they show the change works.',
  B: 'Before you say the change is done, call verify_change with policy recovery-probe.policy.json and base main. Do not call the change done while it is NOT_VERIFIED; report its reasons instead.',
}

/**
 * The checkout of the buggy commit, with the arm's materials committed and pushed as main. Only
 * the buggy commit's history is fetched: a clone would bring the fix, later commits and tags.
 */
async function checkOut(testCase, arm, folder) {
  const workspace = join(folder, 'workspace')
  await git(folder, 'init', '-q', workspace)
  // The committed bytes, as Recovery Probe's own checkouts have them: Git for Windows would
  // otherwise check out CRLF, which fails a project's line-ending lint in arm A's workspace only.
  await git(workspace, 'config', 'core.autocrlf', 'false')
  await git(workspace, 'config', 'core.eol', 'lf')
  await git(
    workspace,
    'fetch',
    '-q',
    '--no-tags',
    '--',
    testCase.repository,
    testCase.buggyCommit,
  )
  await git(workspace, 'checkout', '-q', '--detach', 'FETCH_HEAD')
  if (arm === 'B')
    await cp(join(testCase.folder, 'policy'), workspace, { recursive: true })
  else await cp(join(testCase.folder, 'arm-a.md'), join(workspace, 'VERIFY.md'))
  await git(workspace, 'add', '-A')
  await git(
    workspace,
    'commit',
    '-q',
    '--no-gpg-sign',
    '--allow-empty',
    '-m',
    'Pilot base',
  )
  const remote = join(folder, 'remote.git')
  await git(folder, 'init', '-q', '--bare', remote)
  await git(workspace, 'remote', 'add', 'origin', remote)
  await git(workspace, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  await git(workspace, 'checkout', '-q', '-B', 'main', 'origin/main')
  await git(workspace, 'branch', '-q', '--set-upstream-to', 'origin/main')
  return workspace
}

/**
 * Prepares a session in `folder`. Refuses a workspace inside the grading folder or the
 * repository, or the other way round, before anything is written.
 */
export async function prepareSession({ testCase, arm, folder, grading, cli }) {
  const workspace = join(folder, 'workspace')
  for (const [place, name] of [
    [grading, 'the grading folder'],
    [repository, 'this repository'],
  ])
    if (isInside(workspace, place) || isInside(place, workspace))
      throw new Error(`A workspace must be outside ${name}, and not around it`)
  await mkdir(join(folder, 'harness'), { recursive: true })
  await checkOut(testCase, arm, folder)
  const denied = [grading, repository, join(folder, 'harness')]
  const settings = join(folder, 'harness', 'settings.json')
  await writeFile(
    settings,
    JSON.stringify({
      permissions: {
        deny: denied.map((path) => `Read(${everythingUnder(path)})`),
      },
      disableAllHooks: true,
    }),
  )
  const mcpConfig = join(folder, 'harness', 'mcp.json')
  const servers =
    arm === 'B'
      ? { 'recovery-probe': { command: process.execPath, args: [cli, 'mcp'] } }
      : {}
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: servers }))
  const issue = await readFile(join(testCase.folder, 'ISSUE.md'), 'utf8')
  return {
    workspace,
    settings,
    mcpConfig,
    denied,
    prompt: `${issue.trim()}\n\n${ARM_TEXT[arm]}\n`,
  }
}
