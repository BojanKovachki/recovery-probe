import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedLines, scanForSuspects } from '../../dist/suspects.mjs'
import { recordBaseline, verifyChange, verifyPlan } from '../../dist/verify.mjs'

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
    checks: [
      { name: 'add', command: ['ipc', '--action', '--config', 'a.json'] },
    ],
  })

test('a plan names unique checks that can be rerun', () => {
  assert.deepEqual(plan().checks[0].name, 'add')
  assert.equal(verifyPlan({ checks: plan().checks }).runs, 3)
  for (const bad of [
    {},
    { checks: [] },
    { checks: [{ name: 'x y', command: ['ipc', '--config', 'a'] }] },
    { checks: [{ name: 'x', command: ['ipc'] }] },
    {
      checks: [{ name: 'x', command: ['ipc', '--config', 'a', '--out', 'o'] }],
    },
    {
      checks: [
        { name: 'x', command: ['ipc', '--config', 'a'] },
        { name: 'x', command: ['ipc', '--config', 'b'] },
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
      checks: [
        { name: 'add', command: ['ipc', '--action', '--config', 'b.json'] },
      ],
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
