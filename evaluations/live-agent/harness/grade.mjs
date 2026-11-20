// Grades a run's unsealed attempts with the hidden behavior checks, which are independent of
// Recovery Probe and of the agents' own tests, then scores and aggregates them.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChecks } from '../grading/run-checks.mjs'
import { assertFrozen } from './freeze.mjs'
import { markdownSummary } from './report.mjs'
import { aggregate, scoreAttempt } from './score.mjs'
import {
  attemptStart,
  gradingRules,
  hiddenFromDisk,
  loadPilot,
  loadTask,
  scenarioFiles,
} from './tasks.mjs'
import { applyChanges, writeTree } from './workspace.mjs'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/** Whether the task's original tests still pass against the attempt's code. */
async function originalTests(directory, tree) {
  const tests = Object.fromEntries(
    Object.entries(tree).filter(([path]) => /^test\/.+\.test\.js$/.test(path)),
  )
  await writeTree(directory, tests)
  try {
    execFileSync(process.execPath, ['--test', ...Object.keys(tests)], {
      cwd: directory,
      stdio: 'pipe',
      timeout: 120000,
    })
    return true
  } catch {
    return false
  }
}

/** Rebuilds the attempt's final code from its start and diff, and grades it. */
export async function gradeAttempt(directory, hidden, rules) {
  const record = JSON.parse(
    await readFile(join(directory, 'attempt.json'), 'utf8'),
  )
  const diff = await readFile(join(directory, 'final.diff'), 'utf8')
  const task = await loadTask(record.task)
  const rule = rules.tasks[record.task]
  const scenarios =
    record.condition === 'B' ? await scenarioFiles(task.app) : {}
  const tree = attemptStart(task, record.condition, hidden, scenarios)
  const app = await mkdtemp(join(tmpdir(), 'rp-live-grade-'))
  try {
    const start = await applyChanges(app, tree, diff)
    if (start !== record.startCommit)
      throw new Error(
        `${record.id} started from ${record.startCommit}, but its start rebuilds as ${start}`,
      )
    const checks = await runChecks(app, rule)
    const grade = {
      ...checks,
      originalTestsPass: await originalTests(app, tree),
    }
    return {
      record,
      grade,
      score: scoreAttempt(rule, record, grade, rules.appSource),
    }
  } finally {
    await rm(app, { recursive: true, force: true, maxRetries: 10 })
  }
}

/** Grades every attempt of the unsealed run in `runDirectory`; writes results and a summary. */
export async function gradeRun(runDirectory) {
  const hidden = await hiddenFromDisk()
  await assertFrozen(runDirectory, hidden)
  const rules = gradingRules(hidden)
  const folder = join(runDirectory, 'attempts')
  const names = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const graded = []
  for (const name of names) {
    const { record, grade, score } = await gradeAttempt(
      join(folder, name),
      hidden,
      rules,
    )
    await writeFile(join(folder, name, 'grade.json'), json({ grade, score }))
    graded.push({
      id: record.id,
      order: record.order,
      task: record.task,
      condition: record.condition,
      repetition: record.repetition,
      metrics: record.metrics,
      score,
    })
    console.log(
      `${record.id}: ${score.success ? 'success' : 'no success'}; status ${score.status ?? 'none'}; execution ${score.execution}`,
    )
  }
  const summary = aggregate(graded)
  const pilot = await loadPilot()
  await writeFile(
    join(runDirectory, 'results.json'),
    json({ gradedAt: new Date().toISOString(), attempts: graded, summary }),
  )
  await writeFile(
    join(runDirectory, 'summary.md'),
    markdownSummary(pilot, graded, summary),
  )
  return { graded, summary }
}
