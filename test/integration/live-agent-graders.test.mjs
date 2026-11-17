import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChecks } from '../../evaluations/live-agent/grading/run-checks.mjs'
import {
  attemptStart,
  gradingRules,
  hiddenFromDisk,
  loadTask,
} from '../../evaluations/live-agent/harness/tasks.mjs'
import { writeTree } from '../../evaluations/live-agent/harness/workspace.mjs'

const hidden = await hiddenFromDisk()
const rules = gradingRules(hidden)
const failing = (results) =>
  Object.entries(results)
    .filter(([, result]) => !result.pass)
    .map(([name]) => name)

async function checksOn(tree, rule) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-live-graders-'))
  try {
    await writeTree(directory, tree)
    return await runChecks(directory, rule)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10 })
  }
}

// The graders decide the pilot's results: each must tell a task's defect from the reference.
for (const [id, rule] of Object.entries(rules.tasks).filter(
  ([, rule]) => rule.kind === 'fix',
)) {
  test(`the graders of ${id} fail its starting code and pass the reference`, async () => {
    const task = await loadTask(id)
    const start = await checksOn(attemptStart(task, 'A', hidden), rule)
    assert.deepEqual(failing(start.required), rule.required)
    assert.deepEqual(failing(start.regression), [])
    const reference = await checksOn(
      attemptStart({ ...task, overlay: {} }, 'A', hidden),
      rule,
    )
    assert.deepEqual(failing(reference.required), [])
    assert.deepEqual(failing(reference.regression), [])
  })
}
