// Runs the scenario self-check evaluation and prints what each case actually produced.
// Usage: npm run eval:self-check [-- [--runs N] case-id ...]
import { mkdir, writeFile } from 'node:fs/promises'
import { evaluateSelfCheck } from '../test/helpers/self-check-evaluation.mjs'

const list = (items) => (items.length ? items.join(', ') : '—')
const args = process.argv.slice(2)
const runsAt = args.indexOf('--runs')
const runs = runsAt === -1 ? 3 : Number(args.splice(runsAt, 2)[1])
const results = await evaluateSelfCheck(args.length ? args : undefined, {
  runs,
})
for (const { id, actual, checks, passed } of results) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id}`)
  console.log(
    `      outcome: ${actual.outcome} over ${actual.runs} run(s); problems: ${list(actual.problems)}`,
  )
  console.log(
    `      differences: ${list(actual.differences)}; CONTENT_BEFORE_READ basis: ${list(actual.contentBeforeRead)}; gaps: ${list(actual.gaps)}`,
  )
  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  if (failed.length)
    console.log(
      `      differs from expected: ${failed.map(([name]) => name).join(', ')}`,
    )
}
await mkdir('artifacts', { recursive: true })
await writeFile(
  'artifacts/self-check-evaluation.json',
  `${JSON.stringify(results, null, 2)}\n`,
)
console.log(
  `\n${results.filter((r) => r.passed).length} of ${results.length} cases as expected. Details: artifacts/self-check-evaluation.json`,
)
process.exitCode = results.every((r) => r.passed) ? 0 : 1
