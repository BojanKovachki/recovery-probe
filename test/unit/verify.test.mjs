import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goldenSequence, OLD_FIELDS } from '../helpers/verify-golden.mjs'
import { changedLines } from '../../dist/tools/suspects/files.mjs'
import { scanForSuspects } from '../../dist/tools/suspects/scan.mjs'
import {
  recordBaseline,
  verifyChange,
  verifyPlan,
} from '../../dist/tools/verify.mjs'

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
  })

// A committed store with a suspect on line 2, so only an edit there is new.
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-verify-'))
  git(root, 'init', '-q', '-b', 'main')
  await mkdir(join(root, 'src'))
  await writeFile(
    join(root, 'src', 'store.ts'),
    'export const a = 1\nexport const rows = async () => (await load()) ?? []\nexport const b = 2\n',
  )
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'start')
  return root
}

async function inside(root, run) {
  const previous = process.cwd()
  process.chdir(root)
  try {
    return await run()
  } finally {
    process.chdir(previous)
    await rm(root, { recursive: true, force: true })
  }
}

const action = (findings) =>
  JSON.stringify({
    schemaVersion: 1,
    mode: 'IPC action check',
    channel: 'contacts:add',
    findings: findings.map(([classification, kind]) => ({
      classification,
      kind,
    })),
  })

// A check runner that writes the next report from the list into --out.
const runner = (reports) => async (args) => {
  const folder = args[args.indexOf('--out') + 1]
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'report.json'), reports.shift())
  return { exitCode: 0, output: 'checked\n' }
}

const plan = (runs = 1) =>
  verifyPlan({
    base: 'main',
    runs,
    checks: [{ name: 'add', command: ['action', '--config', 'a.json'] }],
  })

test('a plan names unique checks that can be rerun', () => {
  assert.deepEqual(plan().checks[0].name, 'add')
  assert.equal(verifyPlan({ checks: plan().checks }).runs, 3)
  for (const bad of [
    {},
    { checks: [] },
    { checks: [{ name: 'x y', command: ['check', '--config', 'a'] }] },
    { checks: [{ name: 'x', command: ['check'] }] },
    {
      checks: [
        { name: 'x', command: ['check', '--config', 'a', '--out', 'o'] },
      ],
    },
    {
      checks: [
        { name: 'x', command: ['check', '--config', 'a'] },
        { name: 'x', command: ['check', '--config', 'b'] },
      ],
    },
    { runs: 0, checks: plan().checks },
    { extra: true, checks: plan().checks },
  ])
    assert.throws(() => verifyPlan(bad), undefined, JSON.stringify(bad))
})

test('changed lines cover edits, additions and untracked files, and suspects can be limited to them', async () => {
  const root = await repo()
  await inside(root, async () => {
    await writeFile(
      join(root, 'src', 'store.ts'),
      'export const a = 1\nexport const rows = async () => (await load()) ?? []\nexport const b = 3\nexport const c = 4\n',
    )
    await writeFile(join(root, 'src', 'new.ts'), 'export const d = 5\n')
    const changed = await changedLines('main')
    const lines = [...changed].map(([path, value]) => [
      path.split(/[\\/]/).at(-1),
      value === true ? true : [...value],
    ])
    assert.deepEqual(lines, [
      ['store.ts', [3, 4]],
      ['new.ts', true],
    ])
    // The suspect on line 2 predates the change.
    assert.equal(
      (await scanForSuspects({ changedSince: 'main' })).suspects.length,
      1,
    )
    assert.equal(
      (await scanForSuspects({ changedSince: 'main', changedLinesOnly: true }))
        .suspects.length,
      0,
    )
  })
})

test('a change is verified only when its checks improved or stayed clean, with complete runs and no new suspects', async () => {
  const root = await repo()
  await inside(root, async () => {
    const out = join(root, '.recovery-probe', 'verify')
    await assert.rejects(
      verifyChange({ plan: plan(), directory: out, runCommand: runner([]) }),
      /No baseline/,
    )

    await recordBaseline({
      plan: plan(2),
      directory: out,
      runCommand: runner([
        action([['SILENT_FAILURE', 'suspected-defect']]),
        action([['SILENT_FAILURE', 'suspected-defect']]),
      ]),
    })
    const fixed = await verifyChange({
      plan: plan(2),
      directory: out,
      runCommand: runner([
        action([['FEEDBACK_SHOWN', 'observation']]),
        action([['FEEDBACK_SHOWN', 'observation']]),
      ]),
    })
    assert.equal(fixed.verdict, 'VERIFIED', fixed.reasons.join('; '))
    assert.equal(fixed.exitCode, 0)
    assert.equal(fixed.checks[0].comparison.verdict, 'IMPROVED')
    assert.match(
      await readFile(join(out, 'summary.md'), 'utf8'),
      /verify: verified\*\*[\s\S]*`add`: /,
    )

    const regressed = await verifyChange({
      plan: plan(2),
      directory: out,
      runCommand: runner([
        action([['DUPLICATE_SUBMIT', 'suspected-defect']]),
        action([['DUPLICATE_SUBMIT', 'suspected-defect']]),
      ]),
    })
    assert.equal(regressed.verdict, 'NOT_VERIFIED')
    assert.equal(regressed.exitCode, 1)

    const stopped = await verifyChange({
      plan: plan(2),
      directory: out,
      runCommand: runner([
        action([['FEEDBACK_SHOWN', 'observation']]),
        action([['FAULT_NOT_TRIGGERED', 'inconclusive']]),
      ]),
    })
    assert.equal(stopped.verdict, 'NOT_VERIFIED')
    assert.match(
      stopped.reasons[0],
      /1 of 2 runs after the change were incomplete/,
    )

    const renamed = verifyPlan({
      runs: 2,
      checks: [{ name: 'add', command: ['action', '--config', 'b.json'] }],
    })
    const changedCheck = await verifyChange({
      plan: renamed,
      directory: out,
      runCommand: runner([
        action([['FEEDBACK_SHOWN', 'observation']]),
        action([['FEEDBACK_SHOWN', 'observation']]),
      ]),
    })
    assert.match(changedCheck.reasons[0], /changed since the baseline/)

    // The fix itself adds a suspect on a changed line.
    await writeFile(
      join(root, 'src', 'store.ts'),
      'export const a = 1\nexport const rows = async () => (await load()) ?? []\nexport const more = async () => (await load()) ?? []\n',
    )
    const suspect = await verifyChange({
      plan: plan(2),
      directory: out,
      runCommand: runner([
        action([['FEEDBACK_SHOWN', 'observation']]),
        action([['FEEDBACK_SHOWN', 'observation']]),
      ]),
    })
    assert.equal(suspect.verdict, 'NOT_VERIFIED')
    assert.deepEqual(
      suspect.suspects.map((s) => [s.file, s.line]),
      [['src/store.ts', 3]],
    )
    assert.equal(suspect.exitCode, 2)
  })
})

test('a stop ends the run in progress, starts no more, keeps the last baseline and still writes a summary', async () => {
  const root = await repo()
  await inside(root, async () => {
    const out = join(root, 'out')
    await recordBaseline({
      plan: plan(2),
      directory: out,
      runCommand: runner([action([]), action([])]),
    })
    for (const record of [verifyChange, recordBaseline]) {
      const abort = new AbortController()
      /** @type {unknown[]} */
      const limits = []
      const stopping = record({
        plan: plan(2),
        directory: out,
        signal: abort.signal,
        runCommand: async (_args, given) => {
          limits.push(given)
          // The stop arrives while this run is in progress.
          abort.abort()
          return { exitCode: null, output: '', stopped: 'cancelled' }
        },
      })
      await assert.rejects(
        stopping,
        record === recordBaseline
          ? /Stopped before the baseline was recorded/
          : /nothing was verified/,
      )
      assert.deepEqual(limits, [{ signal: abort.signal }])
    }
    const summary = JSON.parse(
      await readFile(join(out, 'summary.json'), 'utf8'),
    )
    assert.equal(summary.verdict, 'NOT_VERIFIED')
    assert.equal(summary.exitCode, 2)
    assert.equal(summary.run.status, 'cancelled')
    assert.deepEqual(
      summary.claims.map((claim) => [
        claim.reason,
        claim.execution.attempts.length,
      ]),
      [
        ['NOT_RUN', 1],
        ['NOT_RUN', 0],
      ],
    )
    assert.ok(!existsSync(join(out, 'verification.partial.json')))
    assert.ok(existsSync(join(out, 'before', 'baseline.json')), 'kept')
    assert.ok(existsSync(join(out, 'before', 'add', 'run-2', 'report.json')))
  })
})

test('without a policy, the older fields stay as they were, and each claim agrees with its check', async () => {
  const expected = JSON.parse(
    await readFile(
      new URL('../fixtures/verify-golden.json', import.meta.url),
      'utf8',
    ),
  )
  assert.deepEqual(await goldenSequence(), expected)
  const results = await goldenSequence([
    ...OLD_FIELDS,
    'claims',
    'schema',
    'mode',
  ])
  assert.deepEqual(
    results.map((result) =>
      result.claims.map(
        (claim) => `${claim.id} ${claim.outcome} ${claim.reason}`,
      ),
    ),
    [
      [
        'behavior/add VERIFIED PASSED',
        'suspects/changed-lines VERIFIED PASSED',
      ],
      [
        'behavior/add FAILED NEW_FAILURE',
        'suspects/changed-lines VERIFIED PASSED',
      ],
      [
        'behavior/add NOT_VERIFIED FAULT_NOT_TRIGGERED',
        'suspects/changed-lines VERIFIED PASSED',
      ],
      [
        'behavior/add NOT_VERIFIED EXPECTATION_CHANGED',
        'suspects/changed-lines VERIFIED PASSED',
      ],
      [
        'behavior/add VERIFIED PASSED',
        'suspects/changed-lines NOT_VERIFIED SUSPECTS_ON_CHANGED_LINES',
      ],
    ],
  )
  for (const result of results) {
    assert.equal(result.schema, 'recovery-probe/verification@1')
    assert.equal(result.mode, 'plan')
    assert.equal(
      result.claims[0].outcome === 'VERIFIED',
      result.checks[0].verified,
    )
    assert.equal(result.claims[0].expectation.source, 'plan')
    assert.equal(result.claims[0].expectation.approved, false)
  }
})

test('a verification in progress keeps verification.partial.json up to date', async () => {
  const root = await repo()
  await inside(root, async () => {
    const out = join(root, 'out')
    await recordBaseline({
      plan: plan(2),
      directory: out,
      runCommand: runner([action([]), action([])]),
    })
    const reports = [action([]), action([])]
    /** @type {any[]} */
    const seen = []
    await verifyChange({
      plan: plan(2),
      directory: out,
      runCommand: async (args) => {
        const partial = join(out, 'verification.partial.json')
        seen.push(JSON.parse(await readFile(partial, 'utf8')))
        return runner(reports)(args)
      },
    })
    assert.deepEqual(
      seen.map((partial) => [
        partial.run.status,
        partial.claims[0].reason,
        partial.claims[0].execution.attempts.length,
      ]),
      [
        ['running', 'NOT_RUN', 0],
        ['running', 'NOT_RUN', 1],
      ],
    )
    assert.ok(!existsSync(join(out, 'verification.partial.json')))
  })
})
