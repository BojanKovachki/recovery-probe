// Runs the verifier evaluation and prints what each case actually produced.
// Usage: npm run eval:verifier [-- case-id ...]
import { mkdir, writeFile } from 'node:fs/promises'
import { evaluateVerifier } from '../test/helpers/verifier-evaluation.mjs'

const args = process.argv.slice(2)
const results = await evaluateVerifier(args.length ? args : undefined)
for (const { id, actual, checks, passed } of results) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id}`)
  console.log(
    `      verdict: ${actual.verdict}, exit ${actual.exitCode}; claim: ${actual.claim}; base comparison: ${actual.baseline ?? '—'}; run: ${actual.runStatus}; both sides ran: ${actual.bothSides}`,
  )
  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  if (failed.length) {
    console.log(
      `      differs from expected: ${failed.map(([name]) => name).join(', ')}`,
    )
    for (const gap of actual.gaps) console.log(`      gap: ${gap}`)
  }
}
await mkdir('artifacts', { recursive: true })
await writeFile(
  'artifacts/verifier-evaluation.json',
  `${JSON.stringify(results, null, 2)}\n`,
)
console.log(
  `\n${results.filter((r) => r.passed).length} of ${results.length} cases as expected. Details: artifacts/verifier-evaluation.json`,
)
process.exitCode = results.every((r) => r.passed) ? 0 : 1
