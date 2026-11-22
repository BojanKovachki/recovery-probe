// The verifier evaluation. Each case builds the synthetic project in a temporary Git repository:
// the project and the case's base files are committed on main and pushed to a bare remote, and
// the case's change is left in the working tree. Policy mode then verifies the change, launching
// the app from each side's checkout. expected.json, which the verifier never sees, scores it.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { freePort, portOpen } from '../../dist/core/ports.mjs'
import { verifyPolicy } from '../../dist/tools/verify.mjs'

export const fixtures = fileURLToPath(
  new URL('../fixtures/verifier-evaluation/', import.meta.url),
)
const CLAIM = 'behavior/items-keep-content'

const git = (cwd, ...args) =>
  promisify(execFile)(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd },
  )

async function filesUnder(directory) {
  if (!existsSync(directory)) return []
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
}

/** Copies `from` into `to`, with each {{port}} replaced. */
async function copyInto(from, to, port) {
  for (const path of await filesUnder(from)) {
    const text = await readFile(join(from, path), 'utf8')
    await mkdir(dirname(join(to, path)), { recursive: true })
    await writeFile(join(to, path), text.replaceAll('{{port}}', String(port)))
  }
}

/** The case's repository: base committed and pushed, the change in the working tree. */
async function repositoryFor(id, root) {
  const repo = join(root, 'repo')
  const port = await freePort()
  await copyInto(join(fixtures, 'project'), repo, port)
  await copyInto(join(fixtures, 'cases', id, 'base'), repo, port)
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'core.autocrlf', 'false')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'base')
  await git(root, 'init', '-q', '--bare', 'remote.git')
  await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'))
  await git(repo, 'push', '-q', 'origin', 'main')
  await copyInto(join(fixtures, 'cases', id, 'change'), repo, port)
  return { repo, port }
}

const optionsOf = async (id) => {
  const file = join(fixtures, 'cases', id, 'options.json')
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {}
}

/** Verifies one case's change and reduces the result to what expected.json scores. */
async function runCase(id) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'recovery-probe-verifier-eval-')),
  )
  const previous = process.cwd()
  try {
    const { repo, port } = await repositoryFor(id, root)
    process.chdir(repo)
    const result = await verifyPolicy({
      policy: 'recovery-probe.policy.json',
      base: 'main',
      ...(await optionsOf(id)),
    })
    const claim = result.claims.find((found) => found.id === CLAIM)
    const sides = new Set(claim?.execution.attempts.map((a) => a.side))
    return {
      verdict: result.verdict,
      exitCode: result.exitCode,
      claim: claim && `${claim.outcome} ${claim.reason}`,
      baseline: claim?.baseline.comparison,
      runStatus: result.run.status,
      bothSides: sides.has('base') && sides.has('candidate'),
      commits: {
        base: result.revisions.base.commit,
        candidate: result.revisions.candidate.snapshotCommit,
      },
      appStopped: !(await portOpen(new URL(`http://127.0.0.1:${port}/health`))),
      reasons: result.reasons,
      gaps: claim?.gaps ?? [],
    }
  } finally {
    process.chdir(previous)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** Runs the cases named in `ids`, or all of them, one after another. */
export async function evaluateVerifier(ids) {
  const expected = JSON.parse(
    await readFile(join(fixtures, 'expected.json'), 'utf8'),
  )
  const ci = process.env.CI
  // A local run then counts the base as local; it's on its bare remote either way.
  delete process.env.CI
  const results = []
  try {
    for (const id of ids ?? Object.keys(expected)) {
      const actual = await runCase(id)
      const checks = Object.fromEntries(
        Object.entries(expected[id]).map(([key, value]) => [
          key,
          actual[key] === value,
        ]),
      )
      checks.appStopped = actual.appStopped
      checks.commitsRecorded = Boolean(
        actual.commits.base && actual.commits.candidate,
      )
      results.push({
        id,
        expected: expected[id],
        actual,
        checks,
        passed: Object.values(checks).every(Boolean),
      })
    }
  } finally {
    if (ci !== undefined) process.env.CI = ci
  }
  return results
}
