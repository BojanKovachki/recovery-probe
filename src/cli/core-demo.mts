import { mkdir, writeFile } from 'node:fs/promises'

// The examples stay plain JavaScript, so this one is loaded by URL at run time.
const { runCoreDemo } = (await import(
  new URL('../../examples/core-demo.mjs', import.meta.url).href
)) as {
  runCoreDemo: () => Promise<{ expectedDemonstrationVerified: boolean }>
}
const report = await runCoreDemo()
await mkdir('artifacts', { recursive: true })
await writeFile(
  'artifacts/core-demo.json',
  JSON.stringify(report, null, 2) + '\n',
)
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.expectedDemonstrationVerified ? 0 : 1
