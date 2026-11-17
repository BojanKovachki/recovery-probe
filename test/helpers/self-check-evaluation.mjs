// The scenario self-check evaluation. Each case serves the planner evaluation's synthetic app and
// registry, with the case's files on top, as the reference build, and self-checks one registered
// scenario on it with the CLI. expected.json, which the self-check never sees, scores the result.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fixtures as planFixtures,
  overlay,
  recoveryProbe,
  startApp,
} from './plan-evaluation.mjs'

const fixtures = fileURLToPath(
  new URL('../fixtures/self-check-evaluation/', import.meta.url),
)

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

/** Serves the case's app and self-checks its scenario on it. */
async function runCase(id, scenario, app, temp, runs) {
  const repo = join(temp, 'repo')
  const folder = join(fixtures, 'cases', id)
  await overlay(join(planFixtures, 'project'), repo, app)
  await overlay(join(folder, 'files'), repo, app)
  const answers = join(folder, 'answers.json')
  await app.serve(repo, existsSync(answers) ? await readJson(answers) : {})
  const reference = `synthetic app: ${id}`
  const { exitCode, output } = await recoveryProbe(
    [
      'self-check',
      scenario,
      '--run',
      '--reference',
      reference,
      '--runs',
      String(runs),
    ],
    repo,
  )
  const saved = join(repo, '.recovery-probe', 'self-check')
  return {
    id,
    exitCode,
    output,
    reference,
    report: await readJson(join(saved, 'report.json')),
    markdown: await readFile(join(saved, 'report.md'), 'utf8'),
  }
}

const codes = (list) => [...new Set(list)].sort()
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** How a case's self-check compares with what expected.json says it should be. */
export function score(result, expected) {
  const { report } = result
  const scenario = report.scenarios[0]
  const runs = scenario?.runs ?? []
  const actual = {
    outcome: scenario?.outcome ?? null,
    problems: codes(runs.flatMap((r) => r.problems.map((p) => p.code))),
    contentBeforeRead: codes(runs.flatMap((r) => r.contentBeforeRead ?? [])),
    differences: codes(
      (scenario?.differences ?? [])
        .filter((d) => d.kind === 'problem')
        .map((d) => d.code),
    ),
    gaps: codes(runs.flatMap((r) => r.gaps)),
    runs: runs.length,
  }
  const listed = (key) =>
    expected[key] === undefined || same(actual[key], codes(expected[key]))
  const checks = {
    outcome: actual.outcome === expected.outcome,
    problems: listed('problems'),
    contentBeforeRead: listed('contentBeforeRead'),
    differences: listed('differences'),
    gaps: (expected.gaps ?? []).every((code) =>
      actual.gaps.some((gap) => gap.includes(code)),
    ),
    exitCode: result.exitCode === (expected.outcome === 'clean' ? 0 : 2),
    noFalseClean: !(actual.outcome === 'clean' && expected.outcome !== 'clean'),
    referenceAsDeclared: same(report.reference, {
      label: result.reference,
      declaredBy: 'user',
    }),
    // Clean says what it does not show; a cause stays a possibility.
    cautious:
      report.limits.some((limit) => limit.includes('never means')) &&
      (actual.outcome !== 'clean' ||
        scenario.guidance.some((line) => line.includes('does not show'))) &&
      (!actual.contentBeforeRead.length ||
        scenario.guidance.some((line) =>
          line.includes('does not show which applies'),
        )),
  }
  return {
    id: result.id,
    actual,
    checks,
    passed: Object.values(checks).every(Boolean),
  }
}

/** Runs every case, or the given ones, and scores each against expected.json. */
export async function evaluateSelfCheck(ids, { runs = 3 } = {}) {
  const expected = await readJson(join(fixtures, 'expected.json'))
  const app = await startApp()
  const results = []
  try {
    for (const id of ids ?? Object.keys(expected)) {
      const temp = await mkdtemp(join(tmpdir(), 'rp-self-check-eval-'))
      try {
        const result = await runCase(id, expected[id].scenario, app, temp, runs)
        results.push({ ...score(result, expected[id]), result })
      } finally {
        await rm(temp, { recursive: true, force: true, maxRetries: 5 })
      }
    }
  } finally {
    await app.close()
  }
  return results
}
