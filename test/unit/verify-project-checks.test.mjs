import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
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
import { planVerificationTool } from '../../dist/tools/mcp/plan-tool.mjs'
import { verifyPolicy } from '../../dist/tools/verify.mjs'
import {
  DEFAULT_TEST_FILES,
  validatePolicy,
} from '../../dist/tools/verify/policy.mjs'
import { proposeChecks } from '../../dist/tools/verify/propose.mjs'

const cli = fileURLToPath(
  new URL('../../bin/recovery-probe.mjs', import.meta.url),
)

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  })

/** A check that exits with the number in status.txt. */
const STATUS = `import { readFileSync } from 'node:fs'
process.exit(Number(readFileSync('status.txt', 'utf8')))
`

const check = (id, script, extra = {}) => ({
  id,
  command: ['node', `checks/${id}.mjs`],
  timeoutMs: 30000,
  ...extra,
  _script: script,
})

/**
 * A repository whose policy has only `checks` as project checks, committed on main and pushed to
 * a bare remote; status.txt holds `base` on main and `candidate` in the working tree. `extra`
 * adds committed files.
 */
async function project({
  checks,
  base = '0',
  candidate = base,
  policy = {},
  extra = {},
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'recovery-probe-project-')),
  )
  const repo = join(root, 'repo')
  const files = {
    'recovery-probe.policy.json': JSON.stringify({
      schema: 'recovery-probe/policy@1',
      projectChecks: checks.map(({ _script, ...rest }) => rest),
      ignore: ['status.txt', 'notes.txt'],
      ...policy,
    }),
    'recovery-probe.registry.json': JSON.stringify({ scenarios: [] }),
    'status.txt': base,
    ...Object.fromEntries(checks.map((c) => [`checks/${c.id}.mjs`, c._script])),
    ...extra,
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), text)
  }
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(root, 'init', '-q', '--bare', 'remote.git')
  git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'))
  git(repo, 'push', '-q', 'origin', 'main')
  await writeFile(join(repo, 'status.txt'), candidate)
  return { root, repo }
}

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

const verify = () =>
  verifyPolicy({ policy: 'recovery-probe.policy.json', base: 'main' })

/** Committed tests, in a folder the policy TESTED ignores, so only `testFiles` judges them. */
const TESTS = { 'test/a.test.mjs': '// a\n', 'test/b.test.mjs': '// b\n' }
const TESTED = { ignore: ['status.txt', 'notes.txt', 'test/**'] }

const byId = (result) =>
  Object.fromEntries(result.claims.map((claim) => [claim.id, claim]))

test('project checks run on both sides and follow the comparison table', async () => {
  /** @type {[string, string, string, string, string, number][]} */
  const table = [
    ['0', '1', 'FAILED', 'NEW_FAILURE', 'NEW_FAILURE', 1],
    ['1', '1', 'FAILED', 'FAILING_ON_BOTH', 'FAILING_ON_BOTH', 2],
    ['1', '0', 'VERIFIED', 'PASSED', 'RESOLVED_FAILURE', 0],
    ['0', '0', 'VERIFIED', 'PASSED', 'STILL_PASSING', 0],
  ]
  for (const [
    base,
    candidate,
    outcome,
    reason,
    comparison,
    exitCode,
  ] of table) {
    const setup = await project({
      checks: [check('status', STATUS)],
      base,
      candidate,
    })
    await inside(setup, async () => {
      const result = await verify()
      const claim = byId(result)['project/status']
      const name = `${base} then ${candidate}`
      assert.deepEqual([claim.outcome, claim.reason], [outcome, reason], name)
      assert.deepEqual(
        claim.baseline,
        { status: 'completed', comparison },
        name,
      )
      assert.equal(result.exitCode, exitCode, name)
      assert.deepEqual(
        claim.execution.attempts.map((attempt) => [
          attempt.side,
          attempt.exitCode,
        ]),
        [
          ['base', Number(base)],
          ['candidate', Number(candidate)],
        ],
        name,
      )
    })
  }
})

test('a new failure exits 1 when the approved criteria ran, even with the policy changed, and 2 when a changed input ran', async () => {
  /** @type {[string, { policy?: true, input?: true, test?: true }, string[], number][]} */
  const cases = [
    [
      'the policy changed',
      { policy: true },
      ['FAILED', 'NEW_FAILURE', 'POLICY_CHANGED'],
      1,
    ],
    [
      'an input changed',
      { input: true },
      ['NOT_VERIFIED', 'CHECK_INPUT_CHANGED', 'CHECK_INPUT_CHANGED'],
      2,
    ],
    [
      'both changed',
      { policy: true, input: true },
      ['NOT_VERIFIED', 'POLICY_CHANGED', 'POLICY_CHANGED'],
      2,
    ],
    [
      'a test changed',
      { test: true },
      ['NOT_VERIFIED', 'TEST_CHANGED', 'TEST_CHANGED'],
      2,
    ],
  ]
  for (const [name, edits, decision, exitCode] of cases) {
    // notes.txt, which the base doesn't have, is the check's input.
    const setup = await project({
      checks: [check('status', STATUS, { inputs: ['notes.txt'] })],
      base: '0',
      candidate: '1',
      policy: TESTED,
      extra: TESTS,
    })
    await inside(setup, async () => {
      if (edits.input) await writeFile('notes.txt', 'changed\n')
      if (edits.test) await writeFile('test/a.test.mjs', '// weakened\n')
      if (edits.policy) {
        const policy = JSON.parse(
          await readFile('recovery-probe.policy.json', 'utf8'),
        )
        delete policy.projectChecks
        await writeFile('recovery-probe.policy.json', JSON.stringify(policy))
      }
      const result = await verify()
      const claim = byId(result)['project/status']
      assert.deepEqual(
        [claim.outcome, claim.reason, claim.criteriaChange],
        decision,
        name,
      )
      assert.equal(claim.baseline.comparison, 'NEW_FAILURE', name)
      assert.equal(result.exitCode, exitCode, name)
      if (decision[0] !== 'FAILED') return
      const both = 'NEW_FAILURE, and POLICY_CHANGED needs approval on the base'
      assert.ok(result.reasons.includes(`project/status: ${both}`), name)
      assert.match(result.markdown, new RegExp(`FAILED \\(${both}\\)`), name)
    })
  }
})

test('a changed or deleted test file needs approval, and an added one only shows for review', async () => {
  /** @type {[string, () => unknown, object[], string, number][]} */
  const cases = [
    [
      'changed',
      () => writeFile('test/a.test.mjs', '// weakened\n'),
      [{ code: 'TEST_FILE_CHANGED', paths: ['test/a.test.mjs'] }],
      'TEST_CHANGED',
      2,
    ],
    [
      'deleted',
      () => rm('test/b.test.mjs'),
      [{ code: 'TEST_FILE_DELETED', paths: ['test/b.test.mjs'] }],
      'TEST_CHANGED',
      2,
    ],
    [
      'renamed',
      () => git('.', 'mv', 'test/a.test.mjs', 'test/moved.test.mjs'),
      [
        { code: 'TEST_FILE_DELETED', paths: ['test/a.test.mjs'] },
        { code: 'TEST_FILE_ADDED', paths: ['test/moved.test.mjs'] },
      ],
      'TEST_CHANGED',
      2,
    ],
    [
      'added',
      () => writeFile('test/new.test.mjs', '// new\n'),
      [{ code: 'TEST_FILE_ADDED', paths: ['test/new.test.mjs'] }],
      'PASSED',
      0,
    ],
  ]
  for (const [name, edit, signals, reason, exitCode] of cases) {
    const setup = await project({
      checks: [check('status', STATUS)],
      policy: TESTED,
      extra: TESTS,
    })
    await inside(setup, async () => {
      await edit()
      const result = await verify()
      const claim = byId(result)['project/status']
      assert.deepEqual(result.reviewSignals, signals, name)
      assert.deepEqual(
        [claim.reason, result.exitCode],
        [reason, exitCode],
        name,
      )
      for (const signal of signals)
        assert.ok(
          result.markdown.includes(
            `- Review signal ${signal.code}: ${signal.paths.join(', ')}`,
          ),
          name,
        )
      const blocking = signals
        .filter((signal) => signal.code !== 'TEST_FILE_ADDED')
        .flatMap((signal) => signal.paths)
      if (!blocking.length) return
      assert.deepEqual(claim.expectation.changedInputs, blocking, name)
      assert.notEqual(
        claim.expectation.candidateVersion,
        claim.expectation.approvedVersion,
        name,
      )
      assert.equal(
        result.reasons.at(-1),
        `${blocking.length} test file(s) changed or deleted, which a person must approve on the base: ${blocking.join(', ')}`,
        name,
      )
    })
  }
})

test("test files are the base policy's patterns: the defaults, its own, or none", async () => {
  /** @type {[string, object, string, string[]][]} */
  const cases = [
    ['the defaults', {}, 'src/c.test.mjs', ['TEST_FILE_CHANGED']],
    ['its own', { testFiles: ['spec/**'] }, 'spec/c.js', ['TEST_FILE_CHANGED']],
    [
      'its own, not the defaults',
      { testFiles: ['spec/**'] },
      'src/c.test.mjs',
      [],
    ],
    ['none', { testFiles: [] }, 'src/c.test.mjs', []],
  ]
  const files = { 'src/c.test.mjs': '// c\n', 'spec/c.js': '// c\n' }
  const ignore = ['status.txt', 'src/**', 'spec/**']
  for (const [name, policy, path, codes] of cases) {
    const setup = await project({
      checks: [check('status', STATUS)],
      policy: { ignore, ...policy },
      extra: files,
    })
    await inside(setup, async () => {
      await writeFile(path, '// edited\n')
      const result = await verify()
      assert.deepEqual(
        result.reviewSignals.map((signal) => signal.code),
        codes,
        name,
      )
      assert.equal(result.verdict, codes.length ? 'NOT_VERIFIED' : 'VERIFIED')
    })
  }
  const setup = await project({
    checks: [check('status', STATUS)],
    policy: { ignore },
    extra: files,
  })
  await inside(setup, async () => {
    const policy = JSON.parse(
      await readFile('recovery-probe.policy.json', 'utf8'),
    )
    await writeFile(
      'recovery-probe.policy.json',
      JSON.stringify({ ...policy, testFiles: [] }),
    )
    await writeFile('src/c.test.mjs', '// edited\n')
    const result = await verify()
    assert.deepEqual(
      result.reviewSignals,
      [{ code: 'TEST_FILE_CHANGED', paths: ['src/c.test.mjs'] }],
      "the candidate's own patterns are never used",
    )
  })
})

test('a pattern input changes when a file it matches is added, edited or removed, and not for line endings or other files', async () => {
  /** @type {[string, () => unknown, string][]} */
  const cases = [
    ['another file', () => writeFile('other/x.txt', 'x\n'), 'PASSED'],
    [
      'line endings',
      async () => {
        git('.', 'config', 'core.autocrlf', 'true')
        await writeFile('config/a.json', '{\r\n}\r\n')
      },
      'PASSED',
    ],
    [
      'an added file',
      () => writeFile('config/b.json', '{}\n'),
      'CHECK_INPUT_CHANGED',
    ],
    [
      'an edited file',
      () => writeFile('config/a.json', '[]\n'),
      'CHECK_INPUT_CHANGED',
    ],
    ['a removed file', () => rm('config/a.json'), 'CHECK_INPUT_CHANGED'],
  ]
  for (const [name, edit, reason] of cases) {
    const setup = await project({
      checks: [check('status', STATUS, { inputs: ['config/**'] })],
      policy: { ignore: ['status.txt', 'config/**', 'other/**'] },
      extra: { 'config/a.json': '{\n}\n', 'other/x.txt': '' },
    })
    await inside(setup, async () => {
      await edit()
      const claim = byId(await verify())['project/status']
      assert.equal(claim.reason, reason, name)
      if (reason !== 'PASSED')
        assert.deepEqual(claim.expectation.changedInputs, ['config/**'], name)
    })
  }
})

test("the command's output lists the review signals with the reasons", async () => {
  const setup = await project({
    checks: [check('status', STATUS)],
    policy: TESTED,
    extra: TESTS,
  })
  await inside(setup, async () => {
    await writeFile('test/a.test.mjs', '// weakened\n')
    await writeFile('test/new.test.mjs', '// new\n')
    const printed = spawnSync(
      process.execPath,
      [
        cli,
        'verify',
        '--policy',
        'recovery-probe.policy.json',
        '--base',
        'main',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(printed.status, 2, printed.stderr)
    assert.match(
      printed.stdout,
      /NOT VERIFIED\r?\n {2}- project\/status: TEST_CHANGED\r?\n.*\r?\n {2}Review signal TEST_FILE_CHANGED: test\/a\.test\.mjs\r?\n {2}Review signal TEST_FILE_ADDED: test\/new\.test\.mjs\r?\n/,
    )
  })
})

test('inputs take files, one JSON value or patterns, and testFiles takes patterns', () => {
  /** @param {object} check @param {object} [rest] */
  const policy = (check, rest = {}) => ({
    schema: 'recovery-probe/policy@1',
    projectChecks: [
      { id: 'c', command: ['node', '-v'], timeoutMs: 1000, ...check },
    ],
    ...rest,
  })
  const inputs = ['a.json', 'a.json#b.c', 'test/**', '**/*.snap']
  assert.deepEqual(
    validatePolicy(policy({ inputs })).projectChecks[0].inputs,
    inputs,
  )
  assert.throws(
    () => validatePolicy(policy({ inputs: ['test/**#b'] })),
    /inputs must list/,
    'a pattern selects no JSON value',
  )
  assert.deepEqual(validatePolicy(policy({})).testFiles, DEFAULT_TEST_FILES)
  assert.deepEqual(validatePolicy(policy({}, { testFiles: [] })).testFiles, [])
  assert.throws(
    () => validatePolicy(policy({}, { testFiles: ['../test/**'] })),
    /testFiles must list relative file patterns/,
  )
})

test('a failure and then a pass is UNSTABLE, with every attempt kept', async () => {
  const flaky = `import { existsSync, writeFileSync } from 'node:fs'
const first = !existsSync('.attempted')
writeFileSync('.attempted', 'x')
process.exit(first ? 1 : 0)
`
  const setup = await project({
    checks: [check('flaky', flaky, { attempts: 2 })],
  })
  await inside(setup, async () => {
    const claim = byId(await verify())['project/flaky']
    assert.deepEqual(
      [claim.outcome, claim.reason],
      ['NOT_VERIFIED', 'UNSTABLE'],
    )
    assert.deepEqual(
      claim.execution.attempts.map((attempt) => [
        attempt.side,
        attempt.n,
        attempt.exitCode,
      ]),
      [
        ['base', 1, 1],
        ['base', 2, 0],
        ['candidate', 1, 1],
        ['candidate', 2, 0],
      ],
    )
  })
})

test('a timeout stops its check and leaves the others and their evidence intact', async () => {
  const setup = await project({
    checks: [
      check('slow', 'setTimeout(() => {}, 60000)\n', { timeoutMs: 1000 }),
      check('fast', 'console.log("fine")\n'),
    ],
  })
  await inside(setup, async () => {
    const claims = byId(await verify())
    assert.deepEqual(
      [claims['project/slow'].outcome, claims['project/slow'].reason],
      ['NOT_VERIFIED', 'TIMED_OUT'],
    )
    assert.equal(claims['project/fast'].outcome, 'VERIFIED')
    const [log] = claims['project/fast'].evidence
    const text = await readFile(
      join('.recovery-probe', 'verify', log.path),
      'utf8',
    )
    assert.equal(text.trim(), 'fine')
  })
})

test('commands get only the allowlisted environment and the names the policy gives, and logs are kept whole', async () => {
  const printing = `console.log('secret=' + (process.env.RP_TEST_SECRET ?? 'none'))
console.log('named=' + (process.env.RP_TEST_NAMED ?? 'none'))
process.stdout.write('x'.repeat(50000) + 'END')
`
  const setup = await project({
    checks: [check('env', printing)],
    policy: { env: ['RP_TEST_NAMED'] },
  })
  process.env.RP_TEST_SECRET = 'hunter2'
  process.env.RP_TEST_NAMED = 'yes'
  try {
    await inside(setup, async () => {
      const result = await verify()
      const claim = byId(result)['project/env']
      const log = claim.evidence.at(-1)
      const bytes = await readFile(join('.recovery-probe', 'verify', log.path))
      const text = bytes.toString('utf8')
      assert.match(text, /^secret=none\r?\nnamed=yes\r?\n/)
      assert.ok(text.endsWith('END') && text.length > 50000, 'the whole log')
      assert.equal(log.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.ok(result.environment.envNames.includes('RP_TEST_NAMED'))
      assert.ok(!result.environment.envNames.includes('RP_TEST_SECRET'))
      assert.ok(!JSON.stringify(result).includes('hunter2'))
    })
  } finally {
    delete process.env.RP_TEST_SECRET
    delete process.env.RP_TEST_NAMED
  }
})

test('a command that changes tracked files is flagged, and the next one runs on the restored checkout', async () => {
  const setup = await project({
    checks: [
      check(
        'writer',
        "import { writeFileSync } from 'node:fs'\nwriteFileSync('status.txt', '7')\n",
      ),
      check('status', STATUS),
    ],
  })
  await inside(setup, async () => {
    const claims = byId(await verify())
    assert.deepEqual(
      [claims['project/writer'].outcome, claims['project/writer'].reason],
      ['NOT_VERIFIED', 'CHECK_MODIFIED_TRACKED_FILES'],
    )
    assert.equal(
      claims['project/status'].outcome,
      'VERIFIED',
      'status.txt was put back',
    )
  })
})

test('setup runs once per side, and a failing setup stops that side', async () => {
  const counted = `import { readFileSync } from 'node:fs'
process.exit(readFileSync('setup.txt', 'utf8') === 'x' ? 0 : 1)
`
  const once = await project({
    checks: [check('counted', counted), check('again', counted)],
    policy: {
      setup: [['node', '-e', "require('fs').appendFileSync('setup.txt', 'x')"]],
    },
  })
  await inside(once, async () => {
    const claims = byId(await verify())
    assert.equal(claims['project/counted'].outcome, 'VERIFIED')
    assert.equal(claims['project/again'].outcome, 'VERIFIED')
  })
  const failing = await project({
    checks: [check('status', STATUS)],
    policy: { setup: [['node', '-e', 'process.exit(4)']] },
  })
  await inside(failing, async () => {
    const claim = byId(await verify())['project/status']
    assert.equal(claim.reason, 'FAILED_TO_START')
    assert.match(
      claim.gaps.join(' '),
      /SETUP_FAILED: node -e process\.exit\(4\) exited with 4/,
    )
  })
})

test('proposals come with their evidence, leave the unclear to a person, and run nothing', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'recovery-probe-propose-')),
  )
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const ran = join(root, 'ran.txt')
  const files = {
    'package.json': JSON.stringify({
      scripts: {
        test: `node -e "require('fs').writeFileSync('ran.txt', 'x')"`,
        lint: 'eslint .',
        dev: 'vite',
        'test:watch': 'vitest --watch',
        typecheck: 'npm run build && tsc',
      },
    }),
    'tsconfig.json': '{}',
    'eslint.config.mjs': 'export default []\n',
    'package-lock.json': '{}',
    'recovery-probe.registry.json': JSON.stringify({ scenarios: [] }),
  }
  for (const [path, text] of Object.entries(files))
    await writeFile(join(root, path), text)
  const proposals = await proposeChecks(root)
  assert.deepEqual(
    proposals.projectChecks.map((p) => [p.id, p.inputs[0], p.evidence[0].file]),
    [
      ['test', 'package.json#scripts.test', 'package.json'],
      ['lint', 'package.json#scripts.lint', 'package.json'],
      ['typecheck', 'tsconfig.json', 'tsconfig.json'],
    ],
  )
  assert.match(
    proposals.projectChecks[1].evidence[0].text,
    /"lint": "eslint \."/,
  )
  assert.equal(proposals.setup[0].command.at(-2), 'ci')
  // A script that isn't a check, such as dev, is neither proposed nor flagged.
  assert.deepEqual(
    proposals.ambiguities.map((ambiguity) => ambiguity.split(' ')[0]),
    ['several', 'scripts.test:watch', 'scripts.typecheck'],
  )
  assert.match(proposals.ambiguities[1], /starts a server or watches/)
  assert.match(proposals.ambiguities[2], /chains commands/)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'base')
  const previous = process.cwd()
  process.chdir(root)
  try {
    const result = /** @type {any} */ (
      await planVerificationTool.run(
        { proposeChecks: true },
        { signal: new AbortController().signal },
      )
    )
    assert.deepEqual(result.proposedChecks, proposals)
    const printed = spawnSync(
      process.execPath,
      [cli, 'verify', '--propose-checks', '--json'],
      { encoding: 'utf8' },
    )
    assert.equal(printed.status, 0, printed.stderr)
    assert.deepEqual(JSON.parse(printed.stdout), proposals)
  } finally {
    process.chdir(previous)
  }
  assert.ok(!existsSync(ran), 'nothing was run')
})
