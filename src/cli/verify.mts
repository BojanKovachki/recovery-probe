import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import {
  recordBaseline,
  verifyChange,
  verifyPlan,
  type VerifyEvent,
} from '../tools/verify.mjs'

const USAGE = 'recovery-probe verify [--baseline] [--plan FILE] [--out FOLDER]'

const HELP = `${USAGE}

Checks a code change with evidence before it is called done. The plan
(.recovery-probe/verify.json by default) lists the checks that prove it:

  { "base": "main", "runs": 3, "checks": [
    { "name": "queue", "command": ["observe", "--config", "observe.json"] } ] }

Run verify --baseline before changing the code, then verify after. It reruns
each check, compares the runs with the baseline, and scans the lines changed
since base for suspects. VERIFIED needs every check improved or clean with
complete runs on both sides, and no suspect on a changed line. Exit code: 0
verified, 1 a new defect, 2 anything else to resolve. See docs/verify.md.`

const shown = (path: string) => relative('.', path).split(sep).join('/') || '.'

function print(event: VerifyEvent) {
  if (event.type === 'running')
    process.stdout.write(`${event.side} ${event.check} run ${event.run}: `)
  else if (event.type === 'ran')
    console.log(
      event.result.evidence
        ? event.result.evidence.complete
          ? 'complete'
          : `incomplete (${event.result.evidence.gaps.join('; ')})`
        : `no report (${event.result.error})`,
    )
  else console.log(`Scanning the lines changed since ${event.base}`)
}

export async function verifyMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  let baseline = false,
    planFile = '.recovery-probe/verify.json',
    directory: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--baseline') baseline = true
    else if ((arg === '--plan' || arg === '--out') && args[i + 1]) {
      if (arg === '--plan') planFile = args[++i]
      else directory = args[++i]
    } else throw new Error(`Use ${USAGE}`)
  }
  const plan = verifyPlan(JSON.parse(await readFile(planFile, 'utf8')))
  const options = { plan, directory, onEvent: print }
  if (baseline) {
    await recordBaseline(options)
    console.log(
      'Baseline recorded. Change the code, then run recovery-probe verify.',
    )
    return
  }
  const result = await verifyChange(options)
  console.log(
    `\n${result.verdict === 'VERIFIED' ? 'VERIFIED' : 'NOT VERIFIED'}`,
  )
  for (const reason of result.reasons) console.log(`  - ${reason}`)
  for (const suspect of result.suspects)
    console.log(
      `    ${suspect.file}:${suspect.line}  ${suspect.pattern}${suspect.read ? `  read: ${suspect.read}` : ''}`,
    )
  console.log(`Pull request block: ${shown(result.directory)}/summary.md`)
  process.exitCode = result.exitCode
}
