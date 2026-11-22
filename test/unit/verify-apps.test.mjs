import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, portOpen } from '../../dist/core/ports.mjs'
import { startApp } from '../../dist/tools/verify/apps.mjs'
import { checkOutSides } from '../../dist/tools/verify/checkout.mjs'
import { snapshotCommit, snapshotTree } from '../../dist/tools/verify/git.mjs'

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

/** A repository whose base commit has a fixture, and a folder to launch the app from. */
async function setup(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'recovery-probe-apps-')),
  )
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'fixtures'), { recursive: true })
  await writeFile(join(repo, 'fixtures', 'items.json'), '["approved"]\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  const checkout = join(root, 'checkout')
  await mkdir(join(checkout, 'fixtures'), { recursive: true })
  await writeFile(join(checkout, 'fixtures', 'items.json'), '["changed"]\n')
  // The app answers on its port with the fixture it was given, and keeps running.
  await writeFile(
    join(checkout, 'server.mjs'),
    `import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
createServer((_, response) => response.end(readFileSync('fixtures/items.json'))).listen(Number(process.argv[2]), '127.0.0.1')
`,
  )
  const sides = {
    root: repo,
    cwd: repo,
    base: git(repo, 'rev-parse', 'HEAD'),
    candidate: '',
  }
  return { repo, checkout, sides }
}

const app = (port, extra = {}) => ({
  setup: [],
  launch: [process.execPath, 'server.mjs', String(port)],
  url: `http://127.0.0.1:${port}/`,
  ready: { url: `http://127.0.0.1:${port}/`, timeoutMs: 15000 },
  fixtures: ['fixtures/items.json'],
  ...extra,
})

test('an app runs from its checkout with the approved fixtures, and is stopped with everything it started', async (t) => {
  const { checkout, sides } = await setup(t)
  const port = await freePort()
  const started = await startApp(app(port), checkout, {
    sides,
    setupTimeoutMs: 10000,
  })
  const answer = await fetch(`http://127.0.0.1:${port}/`).then((response) =>
    response.text(),
  )
  assert.equal(answer, '["approved"]\n', 'the fixture comes from the base')
  await started.stop()
  assert.equal(await portOpen(new URL(`http://127.0.0.1:${port}/`)), false)
})

test('a port already in use is refused before anything launches', async (t) => {
  const { checkout, sides } = await setup(t)
  const other = createServer((_, response) => response.end('another build'))
  const port = await new Promise((resolve) =>
    other.listen(0, '127.0.0.1', () =>
      resolve(
        /** @type {import('node:net').AddressInfo} */ (other.address()).port,
      ),
    ),
  )
  t.after(() => new Promise((resolve) => other.close(resolve)))
  await assert.rejects(
    startApp(app(port), checkout, { sides, setupTimeoutMs: 10000 }),
    /127\.0\.0\.1:\d+ is already in use/,
  )
  assert.equal(
    await readFile(join(checkout, 'fixtures', 'items.json'), 'utf8'),
    '["changed"]\n',
    'nothing was touched',
  )
})

test('an app that exits before it is ready, or whose setup fails, is reported', async (t) => {
  const { checkout, sides } = await setup(t)
  const port = await freePort()
  await assert.rejects(
    startApp(
      app(port, {
        launch: [
          process.execPath,
          '-e',
          'console.log("no port"); process.exit(3)',
        ],
      }),
      checkout,
      {
        sides,
        setupTimeoutMs: 10000,
      },
    ),
    /the app exited before it was ready: no port/,
  )
  await assert.rejects(
    startApp(
      app(port, { setup: [[process.execPath, '-e', 'process.exit(5)']] }),
      checkout,
      {
        sides,
        setupTimeoutMs: 10000,
      },
    ),
    /setup .* exited with 5/,
  )
  assert.equal(
    await portOpen(new URL(`http://127.0.0.1:${port}/`)),
    false,
    'nothing left running',
  )
})

test("the candidate's checkout has its uncommitted changes, the base's has none, and both are removed", async (t) => {
  const { repo } = await setup(t)
  await writeFile(join(repo, 'fixtures', 'items.json'), '["uncommitted"]\n')
  await writeFile(join(repo, 'new.txt'), 'untracked\n')
  const head = git(repo, 'rev-parse', 'HEAD')
  const status = git(repo, 'status', '--porcelain')
  const tree = await snapshotTree(repo)
  const commit = await snapshotCommit(repo, tree, head)
  assert.equal(
    await snapshotCommit(repo, tree, head),
    commit,
    'the same tree on the same parent is the same commit',
  )
  assert.equal(
    git(repo, 'status', '--porcelain'),
    status,
    "the user's index and working tree are as they were",
  )
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'no ref moved')
  const checkouts = await checkOutSides(repo, { base: head, candidate: commit })
  assert.equal(
    await readFile(join(checkouts.base, 'fixtures', 'items.json'), 'utf8'),
    '["approved"]\n',
  )
  assert.equal(
    await readFile(join(checkouts.candidate, 'fixtures', 'items.json'), 'utf8'),
    '["uncommitted"]\n',
  )
  assert.ok(existsSync(join(checkouts.candidate, 'new.txt')))
  assert.ok(!existsSync(join(checkouts.base, 'new.txt')))
  assert.equal(git(checkouts.candidate, 'remote'), '', 'no remote to push to')
  await checkouts.remove()
  assert.ok(!existsSync(checkouts.base))
})
