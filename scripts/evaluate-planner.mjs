// Runs the verification-planner evaluation and prints what each case actually produced.
// Usage: npm run eval:planner [-- [--runs N] case-id ...]
import { mkdir, writeFile } from 'node:fs/promises'
import { evaluatePlanner } from '../test/helpers/plan-evaluation.mjs'

const list = (items) => (items.length ? items.join(', ') : '—')
const args = process.argv.slice(2)
const runsAt = args.indexOf('--runs')
const runs = runsAt === -1 ? 1 : Number(args.splice(runsAt, 2)[1])
const results = await evaluatePlanner(args.length ? args : undefined, { runs })
for (const { id, actual, checks, passed } of results) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id}`)
  console.log(
    `      selected: ${list(actual.selected)}; irrelevant: ${list(actual.irrelevantSelected)}`,
  )
  console.log(
    `      suggested: ${list(actual.suggested)}; questions: ${list(actual.questions)}; uncovered: ${list(actual.uncovered)}`,
  )
  console.log(
    `      defect before the change: ${actual.defectBeforeChange ?? 'not run'}; verdict: ${actual.verdict ?? 'not run (no plan)'}`,
  )
  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  if (failed.length)
    console.log(
      `      differs from expected: ${failed.map(([name]) => name).join(', ')}`,
    )
}
await mkdir('artifacts', { recursive: true })
await writeFile(
  'artifacts/planner-evaluation.json',
  `${JSON.stringify(results, null, 2)}\n`,
)
console.log(
  `\n${results.filter((r) => r.passed).length} of ${results.length} cases as expected. Details: artifacts/planner-evaluation.json`,
)
process.exitCode = results.every((r) => r.passed) ? 0 : 1
