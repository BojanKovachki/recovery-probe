// The verifier pilot harness's self-test, on a synthetic project with a stand-in for the agent:
// expected outcomes stay outside every workspace and on the deny list, nothing runs without the
// owner's approval and a passing phase 1, and every session is recorded, failures included.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { runSession } from '../../evaluations/verifier-pilot/harness/attempt.mjs'
import {
  gradingFolder,
  isInside,
  readCases,
  repository,
} from '../../evaluations/verifier-pilot/harness/grading.mjs'
import {
  phase1,
  runPilot,
} from '../../evaluations/verifier-pilot/harness/pilot.mjs'
import { schedule } from '../../evaluations/verifier-pilot/harness/schedule.mjs'
import {
  everythingUnder,
  prepareSession,
} from '../../evaluations/verifier-pilot/harness/workspace.mjs'

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

async function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
}

/**
 * A project whose buggy commit's check fails, and whose fix makes it pass. The check exits 3
 * unless the case's environment reached it.
 */
async function syntheticProject(root) {
  const project = join(root, 'project')
  await write(project, {
    'status.txt': '1',
    'checks/status.mjs':
      "import { readFileSync } from 'node:fs'\nprocess.exit(process.env.PILOT_PROBE === 'yes' ? Number(readFileSync('status.txt', 'utf8')) : 3)\n",
  })
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'config', 'core.autocrlf', 'false')
  git(project, 'add', '.')
  git(project, 'commit', '-q', '-m', 'buggy')
  const buggy = git(project, 'rev-parse', 'HEAD')
  await writeFile(join(project, 'status.txt'), '0')
  git(project, 'commit', '-qam', 'fix')
  return { project, buggy, fix: git(project, 'rev-parse', 'HEAD') }
}

const patch = (from, to) =>
  `diff --git a/status.txt b/status.txt\n--- a/status.txt\n+++ b/status.txt\n@@ -1 +1 @@\n-${from}\n\\ No newline at end of file\n+${to}\n\\ No newline at end of file\n`

/** A grading folder with one usable case, and a broken one when asked. */
async function syntheticGrading(
  root,
  { project, buggy, fix },
  { broken = false } = {},
) {
  const grading = join(root, 'grading')
  const policy = {
    schema: 'recovery-probe/policy@1',
    projectChecks: [
      {
        id: 'status',
        command: ['node', 'checks/status.mjs'],
        timeoutMs: 30000,
      },
    ],
    ignore: ['status.txt'],
    env: ['PILOT_PROBE'],
  }
  const usable = {
    'case.json': JSON.stringify({
      type: 'tests-catch',
      repository: project,
      buggyCommit: buggy,
      fixCommit: fix,
      expected: { fix: 'VERIFIED' },
      environment: { path: [root], variables: { PILOT_PROBE: 'yes' } },
    }),
    'ISSUE.md': 'The status check fails.\n',
    'arm-a.md': 'Run `node checks/status.mjs`; it must exit 0.\n',
    'common/pilot/backend.mjs': '// A stand-in for the app backend.\n',
    'policy/recovery-probe.policy.json': JSON.stringify(policy),
    'policy/recovery-probe.registry.json': JSON.stringify({ scenarios: [] }),
    'phase1.json': JSON.stringify([
      {
        patch: 'real-fix.patch',
        expected: {
          verdict: 'VERIFIED',
          exitCode: 0,
          reasons: { 'project/status': 'PASSED' },
        },
      },
      {
        patch: 'bad.patch',
        expected: {
          verdict: 'NOT_VERIFIED',
          exitCode: 2,
          reasons: { 'project/status': 'FAILING_ON_BOTH' },
        },
      },
    ]),
    'phase1/real-fix.patch': patch(1, 0),
    'phase1/bad.patch': patch(1, 2),
  }
  const files = Object.fromEntries(
    Object.entries(usable).map(([path, text]) => [
      `cases/status-check/${path}`,
      text,
    ]),
  )
  if (broken)
    for (const [path, text] of Object.entries({
      ...usable,
      'case.json': JSON.stringify({
        type: 'base-fails',
        repository: project,
        buggyCommit: '0'.repeat(40),
        fixCommit: fix,
      }),
    }))
      files[`cases/broken/${path}`] = text
  await write(grading, files)
  return grading
}

/** A stand-in agent: reports its workspace and settings, changes a file, and prints a cost. */
async function standIn(root, { sleepMs = 0, cost = true } = {}) {
  const file = join(root, `agent-${sleepMs}-${cost}.mjs`)
  await writeFile(
    file,
    `import { readFileSync, writeFileSync } from 'node:fs'
const [settings] = process.argv.slice(2)
console.log('workspace=' + process.cwd())
console.log('settings=' + readFileSync(settings, 'utf8'))
console.log('probe=' + process.env.PILOT_PROBE)
console.log('path0=' + process.env.PATH.split(${JSON.stringify(delimiter)})[0])
writeFileSync('agent-was-here.txt', 'yes')
setTimeout(() => console.log(${cost} ? JSON.stringify({ total_cost_usd: 0.01 }) : '{}'), ${sleepMs})
`,
  )
  return {
    seed: 7,
    repetitions: 1,
    sessionMinutes: 30,
    budgetUsd: 50,
    agent: {
      command: [process.execPath, file, '{settings}', '{prompt}'],
      costField: 'total_cost_usd',
    },
  }
}

async function setup(t, options) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'recovery-probe-pilot-')),
  )
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const project = await syntheticProject(root)
  const grading = await syntheticGrading(root, project, options)
  return { root, grading }
}

const approve = (grading, extra = {}) =>
  writeFile(
    join(grading, 'approval.json'),
    JSON.stringify({
      cases: ['status-check'],
      budgetUsd: 1,
      approvedBy: 'owner',
      at: '2026-11-22',
      ...extra,
    }),
  )

test('the grading folder must be outside this repository, and a workspace outside the grading folder', async (t) => {
  assert.throws(
    () => gradingFolder(join(repository, 'evaluations')),
    /outside this repository/,
  )
  const { grading } = await setup(t)
  const cases = await readCases(grading)
  await assert.rejects(
    prepareSession({
      testCase: cases[0],
      arm: 'A',
      folder: join(grading, 'session'),
      grading,
      cli: '',
    }),
    /outside the grading folder/,
  )
})

test("a workspace holds the buggy commit's history only, with its committed line endings: the fix, later commits and tags stay out", async (t) => {
  const { root, grading } = await setup(t)
  const [testCase] = await readCases(grading)
  git(testCase.repository, 'tag', 'v2')
  // Git for Windows' usual setting, which would check files out with CRLF.
  const crlf = join(root, 'crlf.gitconfig')
  await writeFile(crlf, '[core]\n\tautocrlf = true\n')
  const global = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = crlf
  t.after(() => {
    if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = global
  })
  for (const arm of ['A', 'B']) {
    const { workspace } = await prepareSession({
      testCase,
      arm,
      folder: join(root, `session-${arm}`),
      grading,
      cli: '',
    })
    const check = await readFile(
      join(workspace, 'checks', 'status.mjs'),
      'utf8',
    )
    assert.ok(!check.includes('\r'), `${arm}: LF, as committed`)
    assert.ok(
      existsSync(join(workspace, 'pilot', 'backend.mjs')),
      `${arm}: the common materials`,
    )
    assert.deepEqual(
      [
        existsSync(join(workspace, 'VERIFY.md')),
        existsSync(join(workspace, 'recovery-probe.policy.json')),
      ],
      [arm === 'A', arm === 'B'],
      `${arm}: only its own arm's materials`,
    )
    assert.equal(git(workspace, 'rev-parse', 'HEAD^'), testCase.buggyCommit)
    const everything = git(workspace, 'log', '--all', '--format=%H').split('\n')
    assert.ok(!everything.includes(testCase.fixCommit), `${arm}: no fix`)
    assert.throws(
      () => git(workspace, 'cat-file', '-e', testCase.fixCommit),
      undefined,
      `${arm}: the fix's objects aren't there either`,
    )
    assert.equal(git(workspace, 'tag'), '', `${arm}: no tags`)
  }
})

test('the schedule is seeded: every case in both arms, repeated, in the same order for the same seed', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const sessions = schedule(ids, 3, 1)
  assert.equal(sessions.length, 36)
  for (const id of ids)
    for (const arm of ['A', 'B'])
      assert.equal(
        sessions.filter((s) => s.case === id && s.arm === arm).length,
        3,
      )
  assert.deepEqual(schedule(ids, 3, 1), sessions)
  assert.notDeepEqual(schedule(ids, 3, 2), sessions)
})

test('phase 1 scores the fixed patches with the case policy, and agents need it to pass and the owner to approve', async (t) => {
  const { root, grading } = await setup(t)
  const pilot = await standIn(root)
  const run = (extra = {}) =>
    runPilot({ grading, run: 'self-test', pilot, values: {}, ...extra })
  await assert.rejects(run(), /No approval/)
  await approve(grading, { budgetUsd: 80 })
  await assert.rejects(run(), /at most the ceiling/)
  await approve(grading)
  await assert.rejects(run(), /Phase 1 must pass/)
  const results = await phase1({ grading, run: 'self-test' })
  assert.deepEqual(
    results.map((result) => [result.patch, result.passed]),
    [
      ['real-fix.patch', true],
      ['bad.patch', true],
    ],
    JSON.stringify(results),
  )
  assert.deepEqual(/** @type {any} */ (results[0]).actual, {
    verdict: 'VERIFIED',
    exitCode: 0,
    reasons: { 'project/status': 'PASSED', 'suspects/changed-lines': 'PASSED' },
  })
})

test('every session is recorded with its transcript and diff, and the agent never gets the grading folder', async (t) => {
  const { root, grading } = await setup(t)
  const pilot = await standIn(root)
  await approve(grading)
  await mkdir(join(grading, 'runs', 'self-test'), { recursive: true })
  await writeFile(
    join(grading, 'runs', 'self-test', 'phase1.json'),
    JSON.stringify([{ passed: true }]),
  )
  const { records } = await runPilot({
    grading,
    run: 'self-test',
    pilot,
    values: {},
  })
  assert.deepEqual(
    records.map((r) => [r.status, r.costUsd]),
    [
      ['completed', 0.01],
      ['completed', 0.01],
    ],
  )
  assert.deepEqual(records.map((r) => r.session.arm).sort(), ['A', 'B'])
  for (const record of records) {
    const folder = join(grading, 'runs', 'self-test', record.session.id)
    const saved = JSON.parse(
      await readFile(join(folder, 'attempt.json'), 'utf8'),
    )
    assert.equal(saved.status, 'completed')
    const transcript = await readFile(join(folder, 'transcript.log'), 'utf8')
    assert.match(transcript, /probe=yes/, "the case's variables")
    assert.equal(
      /path0=(.*)/.exec(transcript)[1].trim(),
      root,
      "the case's folders come first on PATH",
    )
    const workspace = /workspace=(.*)/.exec(transcript)[1].trim()
    assert.ok(
      workspace.startsWith(realpathSync.native(tmpdir())),
      'the agent works in the long form of the path, never an 8.3 short name',
    )
    assert.ok(!isInside(workspace, grading) && !isInside(grading, workspace))
    assert.ok(!isInside(workspace, repository))
    assert.ok(
      transcript.includes(`Read(${everythingUnder(grading)})`),
      'denied in the settings',
    )
    assert.ok(saved.denied.includes(grading))
    assert.match(
      await readFile(join(folder, 'diff.patch'), 'utf8'),
      /agent-was-here\.txt/,
    )
    assert.ok(!existsSync(workspace), 'the session folder is removed')
  }
  const again = await runPilot({ grading, run: 'self-test', pilot, values: {} })
  assert.deepEqual(again.records, [], 'finished sessions are not run again')
})

test('a failed setup, a timeout and a missing cost are recorded, and spending that cannot be tracked stops the run', async (t) => {
  const { root, grading } = await setup(t, { broken: true })
  const [broken, usable] = await readCases(grading)
  const slow = await standIn(root, { sleepMs: 60000 })
  const session = (testCase, id) => ({
    id,
    case: testCase.id,
    arm: 'A',
    repetition: 1,
  })
  const agent = { values: {}, recoveryProbe: '', sessionMs: 2000 }
  const failed = await runSession({
    session: session(broken, '01-broken-A1'),
    testCase: broken,
    pilot: slow,
    grading,
    run: 'self-test',
    agent,
  })
  assert.equal(failed.status, 'setup-failed')
  const timedOut = await runSession({
    session: session(usable, '02-status-check-A1'),
    testCase: usable,
    pilot: slow,
    grading,
    run: 'self-test',
    agent,
  })
  assert.equal(timedOut.status, 'timed-out')
  assert.equal(timedOut.costUsd, 'missing', 'never a guessed zero')
  for (const [id, status] of [
    ['01-broken-A1', 'setup-failed'],
    ['02-status-check-A1', 'timed-out'],
  ]) {
    const file = join(grading, 'runs', 'self-test', id, 'attempt.json')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).status, status, id)
  }

  const unpriced = await setup(t)
  await approve(unpriced.grading)
  await mkdir(join(unpriced.grading, 'runs', 'self-test'), { recursive: true })
  await writeFile(
    join(unpriced.grading, 'runs', 'self-test', 'phase1.json'),
    JSON.stringify([{ passed: true }]),
  )
  const pilot = await standIn(unpriced.root, { cost: false })
  const result = await runPilot({
    grading: unpriced.grading,
    run: 'self-test',
    pilot,
    values: {},
  })
  assert.equal(result.records.length, 1)
  assert.match(result.stopped, /cost is missing, so spending can't be tracked/)
})
