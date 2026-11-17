import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  changedSince,
  definitionHashes,
} from '../../evaluations/live-agent/harness/freeze.mjs'
import { schedule } from '../../evaluations/live-agent/harness/schedule.mjs'
import {
  attemptStart,
  hiddenFromDisk,
  loadPilot,
  loadTask,
  scenarioFiles,
} from '../../evaluations/live-agent/harness/tasks.mjs'
import {
  applyChanges,
  createWorkspace,
  finalChanges,
  git,
  readTree,
} from '../../evaluations/live-agent/harness/workspace.mjs'

const hidden = await hiddenFromDisk()

async function inTemp(run) {
  const root = await mkdtemp(join(tmpdir(), 'rp-live-reset-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

test('every repetition starts from the same commit, in its own folder', async () => {
  const task = await loadTask('filter-race')
  const tree = attemptStart(task, 'B', hidden, await scenarioFiles(task.app))
  await inTemp(async (root) => {
    const first = await createWorkspace(join(root, 'one'), tree)
    const second = await createWorkspace(join(root, 'two'), tree)
    assert.match(first, /^[0-9a-f]{40}$/)
    assert.equal(first, second)
    assert.deepEqual(await readTree(join(root, 'one'), ['.git']), tree)
  })
})

test('the final diff holds every change, committed or not, and rebuilds the same code', async () => {
  const task = await loadTask('refresh-clears-orders')
  const tree = attemptStart(task, 'A', hidden)
  await inTemp(async (root) => {
    const workspace = join(root, 'attempt')
    const start = await createWorkspace(workspace, tree)
    await writeFile(join(workspace, 'public', 'src', 'store.js'), 'export {}\n')
    git(workspace, 'commit', '-qam', 'Fix the store')
    await writeFile(join(workspace, 'repro.mjs'), 'console.log(1)\n')
    await mkdir(join(workspace, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'x', 'index.js'), '')
    await mkdir(join(workspace, '.recovery-probe'))
    await writeFile(join(workspace, '.recovery-probe', 'report.json'), '{}')
    const { diff, paths } = finalChanges(workspace, start)
    assert.deepEqual(paths.sort(), ['public/src/store.js', 'repro.mjs'])

    const rebuilt = join(root, 'rebuilt')
    assert.equal(await applyChanges(rebuilt, tree, diff), start)
    assert.equal(
      await readFile(join(rebuilt, 'public', 'src', 'store.js'), 'utf8'),
      'export {}\n',
    )
    assert.equal(
      await readFile(join(rebuilt, 'repro.mjs'), 'utf8'),
      'console.log(1)\n',
    )
  })
})

test('the attempt order covers every task, condition and repetition once, from a recorded seed', async () => {
  const pilot = await loadPilot()
  const order = schedule(pilot)
  assert.equal(
    order.length,
    pilot.tasks.length * pilot.conditions.length * pilot.repetitions,
  )
  assert.equal(new Set(order.map((attempt) => attempt.id)).size, order.length)
  assert.deepEqual(schedule(pilot), order, 'the same seed, the same order')
  const other = schedule({ ...pilot, seed: pilot.seed + 1 })
  assert.notDeepEqual(
    other.map((attempt) => attempt.id),
    order.map((attempt) => attempt.id),
  )
  // Conditions interleave instead of running all of A, then all of B.
  const firstHalf = order.slice(0, order.length / 2)
  assert.ok(firstHalf.some((attempt) => attempt.condition === 'A'))
  assert.ok(firstHalf.some((attempt) => attempt.condition === 'B'))
})

test('a change to the graders after freezing is detected', async () => {
  const frozen = await definitionHashes(hidden)
  assert.ok(frozen['grading/rules.json'])
  assert.ok(frozen['harness/score.mjs'])
  assert.ok(frozen['tasks/filter-race/ISSUE.md'])
  const changed = await definitionHashes({
    ...hidden,
    'grading/rules.json': Buffer.from('{}'),
  })
  assert.deepEqual(changedSince(frozen, changed), ['grading/rules.json'])
  assert.deepEqual(changedSince(frozen, frozen), [])
})
