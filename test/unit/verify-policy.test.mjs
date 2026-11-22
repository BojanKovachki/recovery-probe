import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyChangeTool } from '../../dist/tools/mcp/change-tools.mjs'
import { verifyPolicy } from '../../dist/tools/verify.mjs'

const cli = fileURLToPath(
  new URL('../../bin/recovery-probe.mjs', import.meta.url),
)

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  })

const scenario = (name, steps) => ({
  name,
  paths: ['src/items.js'],
  check: ['observe', '--config', 'checks/items.json', '--steps', steps],
  behavior: `What ${name} shows.`,
  expectation: `The items list keeps its content (${name}).`,
})

const POLICY = {
  schema: 'recovery-probe/policy@1',
  runs: 1,
  projectChecks: [
    {
      id: 'unit-tests',
      command: ['node', '--test'],
      inputs: ['package.json#scripts.test'],
      timeoutMs: 60000,
    },
  ],
  claims: [
    {
      id: 'items-keep-content',
      failurePath: 'items-fail',
      normalPath: 'items-ok',
      assertions: ['items-visible'],
    },
  ],
  ignore: ['docs/**'],
}

const FILES = {
  'recovery-probe.policy.json': JSON.stringify(POLICY, null, 2),
  'recovery-probe.registry.json': JSON.stringify({
    scenarios: [
      scenario('items-fail', 'checks/items-fail-steps.json'),
      scenario('items-ok', 'checks/items-ok-steps.json'),
    ],
  }),
  'checks/items.json': '{"url": "http://127.0.0.1:9/items"}\n',
  'checks/items-fail-steps.json':
    '[{"expect": {"text": "Items"}, "name": "items-visible"}]\n',
  'checks/items-ok-steps.json':
    '[{"expect": {"text": "Items"}, "name": "items-visible"}]\n',
  'package.json':
    '{\n  "version": "1.0.0",\n  "scripts": { "test": "node --test" }\n}\n',
  'src/items.js': 'export const items = []\n',
}

/**
 * A repository with the policy committed on main, pushed to a bare remote so the base is on
 * origin/main, unless `remote` is false. `files` replaces or adds committed files.
 */
async function project(files = {}, { remote = true } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'recovery-probe-policy-')),
  )
  const repo = join(root, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  for (const [path, text] of Object.entries({ ...FILES, ...files })) {
    if (text === null) continue
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), text)
  }
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'policy')
  if (remote) {
    git(root, 'init', '-q', '--bare', 'remote.git')
    git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'))
    git(repo, 'push', '-q', 'origin', 'main')
  }
  return { root, repo }
}

/** Runs `work` in the repository, outside CI so the base counts as local, then removes it. */
async function inside({ root, repo }, work) {
  const previous = process.cwd()
  const ci = process.env.CI
  delete process.env.CI
  process.chdir(repo)
  try {
    return await work()
  } finally {
    process.chdir(previous)
    if (ci !== undefined) process.env.CI = ci
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** Stands in for Recovery Probe: records each command with the steps it read, writes `report`. */
function runner(report = observeReport()) {
  const calls = []
  return {
    calls,
    async run(args) {
      const steps = args[args.indexOf('--steps') + 1]
      calls.push({ args, steps, content: await readFile(steps, 'utf8') })
      const folder = args[args.indexOf('--out') + 1]
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'report.json'), JSON.stringify(report))
      return { exitCode: 0, output: 'observed\n' }
    },
  }
}

const observeReport = ({ problems = [], status = 'done' } = {}) => ({
  schemaVersion: 1,
  operator: {
    steps: [{ index: 1, kind: 'expect', name: 'items-visible', status }],
  },
  evidence: {
    schema: 'recovery-probe/evidence@1',
    workflow: 'observe',
    complete: true,
    gaps: [],
    problems,
    outcomes: [],
    checked: [''],
  },
})

const verify = (fake) =>
  verifyPolicy({
    policy: 'recovery-probe.policy.json',
    base: 'main',
    runCommand: fake.run,
  })

const byId = (result) =>
  Object.fromEntries(result.claims.map((claim) => [claim.id, claim]))

test('a policy claim is judged by the base and runs its approved files, but needs a launched app to verify', async () => {
  const setup = await project()
  await inside(setup, async () => {
    await writeFile('src/items.js', 'export const items = ["kept"]\n')
    const fake = runner()
    const result = await verify(fake)
    assert.equal(result.mode, 'policy')
    assert.equal(result.verdict, 'NOT_VERIFIED')
    assert.equal(result.exitCode, 2)
    assert.equal(result.policy.source, 'base')
    assert.equal(result.policy.changedInCandidate, false)
    assert.equal(result.baseProvenance.suppliedBy, 'local')
    assert.deepEqual(result.baseProvenance.onRemoteTracking, {
      ref: 'origin/main',
      result: 'equal',
    })
    assert.deepEqual(result.runGaps, [])
    assert.equal(result.revisions.candidate.uncommittedChanges, true)
    assert.deepEqual(result.coverage, { uncovered: [], ignored: [] })
    const claims = byId(result)
    assert.deepEqual(
      Object.values(claims).map(
        (claim) => `${claim.id} ${claim.outcome} ${claim.reason}`,
      ),
      [
        'project/unit-tests NOT_VERIFIED UNAVAILABLE',
        'behavior/items-keep-content NOT_VERIFIED APP_REVISION_UNKNOWN',
        'suspects/changed-lines VERIFIED PASSED',
      ],
    )
    const behavior = claims['behavior/items-keep-content']
    assert.equal(
      behavior.statement,
      'The items list keeps its content (items-fail).',
    )
    assert.equal(behavior.expectation.approved, true)
    assert.match(behavior.expectation.approvedVersion, /^sha256:[0-9a-f]{64}$/)
    assert.deepEqual(
      behavior.execution.attempts.map((attempt) => [
        attempt.path,
        attempt.against,
      ]),
      [
        ['failure', 'approvedVersion'],
        ['normal', 'approvedVersion'],
      ],
    )
    assert.equal(behavior.evidence.length, 2)
    for (const call of fake.calls)
      assert.match(
        call.steps.split('\\').join('/'),
        /verify\/policy\/approved\/checks\//,
      )
    const summary = JSON.parse(
      await readFile('.recovery-probe/verify/summary.json', 'utf8'),
    )
    assert.equal(summary.schema, 'recovery-probe/verification@1')
    assert.equal(summary.claims.length, 3)
  })
})

test('a candidate edit to a step file is EXPECTATION_CHANGED, and the approved copy is the one that runs', async () => {
  const setup = await project()
  await inside(setup, async () => {
    const approved = FILES['checks/items-fail-steps.json']
    await writeFile('checks/items-fail-steps.json', '[{"wait": 10}]\n')
    const fake = runner()
    const claim = byId(await verify(fake))['behavior/items-keep-content']
    assert.equal(claim.reason, 'EXPECTATION_CHANGED')
    assert.equal(claim.expectation.approved, false)
    assert.deepEqual(claim.expectation.changedInputs, [
      'checks/items-fail-steps.json',
    ])
    assert.notEqual(
      claim.expectation.candidateVersion,
      claim.expectation.approvedVersion,
    )
    assert.equal(fake.calls[0].content, approved, 'the base copy ran')
  })
})

test('a candidate edit to the policy changes every claim it governs, and a named input only its check', async () => {
  const setup = await project()
  await inside(setup, async () => {
    const pkg = JSON.parse(FILES['package.json'])
    await writeFile(
      'package.json',
      JSON.stringify({ ...pkg, version: '2.0.0' }),
    )
    let claims = byId(await verify(runner()))
    assert.equal(
      claims['project/unit-tests'].reason,
      'UNAVAILABLE',
      'another field changed',
    )

    await writeFile(
      'package.json',
      JSON.stringify({ ...pkg, scripts: { test: 'echo ok' } }),
    )
    claims = byId(await verify(runner()))
    assert.equal(claims['project/unit-tests'].reason, 'CHECK_INPUT_CHANGED')
    assert.deepEqual(claims['project/unit-tests'].expectation.changedInputs, [
      'package.json#scripts.test',
    ])
    assert.equal(
      claims['behavior/items-keep-content'].reason,
      'APP_REVISION_UNKNOWN',
    )

    await writeFile(
      'recovery-probe.policy.json',
      JSON.stringify({ ...POLICY, ignore: ['docs/**', 'src/**'] }),
    )
    await writeFile('src/theme.js', 'export const theme = {}\n')
    const result = await verify(runner())
    claims = byId(result)
    assert.equal(result.policy.changedInCandidate, true)
    assert.equal(claims['project/unit-tests'].reason, 'POLICY_CHANGED')
    assert.equal(claims['behavior/items-keep-content'].reason, 'POLICY_CHANGED')
    assert.ok(
      result.coverage.uncovered.includes('src/theme.js'),
      "the candidate's ignore rule removes no obligation",
    )
  })
})

test('line endings in the working copy change no hash: hashes use committed bytes', async () => {
  const setup = await project()
  await inside(setup, async () => {
    git('.', 'config', 'core.autocrlf', 'true')
    const steps = FILES['checks/items-fail-steps.json']
    await writeFile(
      'checks/items-fail-steps.json',
      steps.replaceAll('\n', '\r\n'),
    )
    const claim = byId(await verify(runner()))['behavior/items-keep-content']
    assert.equal(claim.reason, 'APP_REVISION_UNKNOWN')
    assert.equal(claim.expectation.approved, true)
  })
})

test('changed files no claim covers block the run, and the base ignore rules leave files out', async () => {
  const setup = await project()
  await inside(setup, async () => {
    await mkdir('docs')
    await writeFile('docs/notes.md', '# Notes\n')
    await writeFile('src/theme.js', 'export const theme = {}\n')
    const result = await verify(runner())
    assert.deepEqual(result.coverage, {
      uncovered: ['src/theme.js'],
      ignored: ['docs/notes.md'],
    })
    assert.match(
      result.reasons.at(-1),
      /1 changed file\(s\) no claim covers: src\/theme\.js/,
    )
  })
})

test('the base must be on its remote branch, and the policy committed and valid there', async () => {
  const local = await project({}, { remote: false })
  await inside(local, async () => {
    const result = await verify(runner())
    assert.deepEqual(result.runGaps, ['BASE_NOT_ON_REMOTE'])
    assert.equal(
      result.baseProvenance.onRemoteTracking.result,
      'no-remote-branch',
    )
  })
  const missing = await project({ 'recovery-probe.policy.json': null })
  await inside(missing, async () => {
    const result = await verify(runner())
    assert.match(result.runGaps[0], /^POLICY_NOT_ON_BASE/)
    assert.equal(result.policy, undefined)
    assert.deepEqual(
      result.claims.map((claim) => claim.id),
      ['suspects/changed-lines'],
    )
    assert.equal(result.exitCode, 2)
  })
  const invalid = await project({
    'recovery-probe.policy.json': JSON.stringify({
      ...POLICY,
      projectChecks: [{ id: 'x', command: ['node'] }],
    }),
  })
  await inside(invalid, async () => {
    const result = await verify(runner())
    assert.match(
      result.runGaps[0],
      /^POLICY_INVALID: projectChecks\[0\]\.timeoutMs is required/,
    )
  })
})

test('a scenario missing from the base registry is EXPECTATION_MISSING and runs nothing', async () => {
  const setup = await project({
    'recovery-probe.policy.json': JSON.stringify({
      ...POLICY,
      claims: [{ ...POLICY.claims[0], normalPath: 'items-gone' }],
    }),
  })
  await inside(setup, async () => {
    const fake = runner()
    const claim = byId(await verify(fake))['behavior/items-keep-content']
    assert.equal(claim.reason, 'EXPECTATION_MISSING')
    assert.equal(claim.execution.status, 'skipped')
    assert.match(claim.gaps[0], /items-gone has no check in the base registry/)
    assert.equal(fake.calls.length, 0)
  })
})

test('a suspected defect or an unmet assertion fails the claim, a lead does not, and nothing new is proven without a base run', async () => {
  /** @type {[ReturnType<typeof observeReport>, string, string][]} */
  const cases = [
    [observeReport({ status: 'unmet' }), 'FAILED', 'NOT_COMPARABLE'],
    [
      observeReport({
        problems: [{ code: 'CONTENT_LOSS', severity: 'defect' }],
      }),
      'FAILED',
      'NOT_COMPARABLE',
    ],
    [
      observeReport({
        problems: [{ code: 'DELAYED_UI_UPDATE', severity: 'lead' }],
      }),
      'NOT_VERIFIED',
      'APP_REVISION_UNKNOWN',
    ],
  ]
  for (const [report, outcome, reason] of cases) {
    const setup = await project()
    await inside(setup, async () => {
      const result = await verify(runner(report))
      const claim = byId(result)['behavior/items-keep-content']
      assert.deepEqual([claim.outcome, claim.reason], [outcome, reason])
      assert.equal(result.exitCode, 2)
    })
  }
})

test('verify_change runs policy mode, returns the last result with status, and refuses a policy without a base', async () => {
  const setup = await project()
  await inside(setup, async () => {
    const signal = new AbortController().signal
    await assert.rejects(
      verifyChangeTool.run({ status: true }, { signal }),
      /No verification has run here yet/,
    )
    await assert.rejects(
      verifyChangeTool.run(
        { policy: 'recovery-probe.policy.json' },
        { signal },
      ),
      /policy needs base/,
    )
    await assert.rejects(
      verifyChangeTool.run(
        { policy: 'recovery-probe.policy.json', base: 'main', baseline: true },
        { signal },
      ),
      /leave out plan and baseline/,
    )
    await verifyPolicy({
      policy: 'recovery-probe.policy.json',
      base: 'main',
      runCommand: runner().run,
    })
    const status = /** @type {any} */ (
      await verifyChangeTool.run({ status: true }, { signal })
    )
    assert.equal(status.source, 'summary')
    assert.equal(status.verdict, 'NOT_VERIFIED')
    assert.equal(status.run.status, 'completed')
    assert.deepEqual(
      status.claims.map((claim) => claim.reason),
      ['UNAVAILABLE', 'APP_REVISION_UNKNOWN', 'PASSED'],
    )
    const usage = spawnSync(
      process.execPath,
      [cli, 'verify', '--policy', 'recovery-probe.policy.json'],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(usage.status, 3)
    assert.match(usage.stderr, /--policy needs --base REF/)
  })
})

test('work that cannot fit in the budget is BUDGET_EXHAUSTED before anything launches, and --budget only goes with a policy', async () => {
  const setup = await project({
    'recovery-probe.policy.json': JSON.stringify({
      ...POLICY,
      claims: [{ ...POLICY.claims[0], app: 'web' }],
      apps: {
        web: {
          launch: ['node', 'server.mjs'],
          url: 'http://127.0.0.1:9/items',
          ready: { url: 'http://127.0.0.1:9/health', timeoutMs: 20000 },
        },
      },
    }),
  })
  await inside(setup, async () => {
    const fake = runner()
    const result = await verifyPolicy({
      policy: 'recovery-probe.policy.json',
      base: 'main',
      budgetMs: 1000,
      runCommand: fake.run,
    })
    const claim = byId(result)['behavior/items-keep-content']
    assert.deepEqual(
      [claim.outcome, claim.reason, claim.execution.status],
      ['NOT_VERIFIED', 'BUDGET_EXHAUSTED', 'budget-exhausted'],
    )
    assert.equal(result.run.status, 'budget-exhausted')
    assert.equal(fake.calls.length, 0)
    assert.match(result.revisions.candidate.snapshotCommit, /^[0-9a-f]{40}$/)
    const usage = spawnSync(
      process.execPath,
      [cli, 'verify', '--budget', '5000'],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(usage.status, 3)
    assert.match(usage.stderr, /--budget goes with --policy/)
    await assert.rejects(
      verifyChangeTool.run(
        { budgetMs: 5000 },
        { signal: new AbortController().signal },
      ),
      /budgetMs goes with policy/,
    )
  })
})

test("an incomplete run's reason is the first code among its gaps, past any plain note", async () => {
  const setup = await project()
  await inside(setup, async () => {
    const report = observeReport()
    report.evidence.complete = false
    report.evidence.gaps = ['capture complete', 'REQUEST_FAULT_NOT_TRIGGERED']
    const claim = byId(await verify(runner(report)))[
      'behavior/items-keep-content'
    ]
    assert.equal(claim.reason, 'REQUEST_FAULT_NOT_TRIGGERED')
  })
})
