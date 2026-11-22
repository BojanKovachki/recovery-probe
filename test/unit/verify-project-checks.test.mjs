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
 * a bare remote; status.txt holds `base` on main and `candidate` in the working tree.
 */
async function project({ checks, base = '0', candidate = base, policy = {} }) {
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
