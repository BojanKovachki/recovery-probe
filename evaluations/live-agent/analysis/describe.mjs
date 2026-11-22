// Describes what the agents of a graded run did, from their transcripts: how they checked
// their work and, in condition B, which Recovery Probe tools they used and what for. It only
// describes; the scores come from the frozen rules in ../harness/score.mjs.
//   node evaluations/live-agent/analysis/describe.mjs [run]
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { events, toolCalls } from '../harness/transcript.mjs'

const run = process.argv[2] ?? 'pilot-1'
const folder = fileURLToPath(new URL(`../runs/${run}/`, import.meta.url))

// What a shell command was for, by what it runs.
const PURPOSES = {
  tests: /npm (run )?test|node --test/,
  app: /npm start|node server\.mjs|Start-Process[^|]*node/,
  browser: /playwright|chromium|open-browser/i,
  recoveryProbe: /recovery-probe /,
}

function describe(record, calls) {
  const commands = calls
    .filter((call) => ['Bash', 'PowerShell'].includes(call.name))
    .map((call) => String(call.input.command ?? ''))
  const uses = Object.fromEntries(
    Object.entries(PURPOSES).map(([purpose, pattern]) => [
      purpose,
      commands.filter((command) => pattern.test(command)).length,
    ]),
  )
  const probe = calls
    .filter((call) => call.name.startsWith('mcp__recovery-probe__'))
    .map((call) => {
      const tool = call.name.slice('mcp__recovery-probe__'.length)
      const args = call.input.args ? ` ${call.input.args[0]}` : ''
      return `${tool}${args}`
    })
  return {
    id: record.id,
    task: record.task,
    condition: record.condition,
    uses,
    probe,
  }
}

const attempts = []
for (const name of (await readdir(join(folder, 'attempts'))).sort()) {
  if (name.endsWith('.sealed')) continue
  const directory = join(folder, 'attempts', name)
  const record = JSON.parse(
    await readFile(join(directory, 'attempt.json'), 'utf8'),
  )
  const calls = toolCalls(
    events(await readFile(join(directory, 'transcript.jsonl'), 'utf8')),
  )
  attempts.push(describe(record, calls))
}

const share = (list, test) => `${list.filter(test).length}/${list.length}`
const lines = [
  `# What the agents did: ${run}`,
  '',
  'Descriptive, from the transcripts; not part of the frozen scoring. A shell command counts once for each purpose its text matches.',
  '',
  '| Condition | Ran tests | Ran the app | Drove a browser | Used Recovery Probe |',
  '| --- | --- | --- | --- | --- |',
  ...['A', 'B'].map((condition) => {
    const group = attempts.filter((a) => a.condition === condition)
    return `| ${condition} | ${share(group, (a) => a.uses.tests)} | ${share(group, (a) => a.uses.app)} | ${share(group, (a) => a.uses.browser)} | ${share(group, (a) => a.probe.length || a.uses.recoveryProbe)} |`
  }),
  '',
  '## Recovery Probe in condition B',
  '',
  '| Attempt | MCP tools, in order | `recovery-probe` commands |',
  '| --- | --- | --- |',
  ...attempts
    .filter((a) => a.condition === 'B')
    .map(
      (a) =>
        `| ${a.id} | ${a.probe.length ? a.probe.join(', ') : '–'} | ${a.uses.recoveryProbe} |`,
    ),
  '',
]
await writeFile(join(folder, 'behavior.md'), `${lines.join('\n')}\n`)
await writeFile(
  join(folder, 'behavior.json'),
  `${JSON.stringify(attempts, null, 2)}\n`,
)
console.log(lines.join('\n'))
