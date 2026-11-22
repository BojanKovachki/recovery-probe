import { relative, sep } from 'node:path'
import {
  recordBaseline,
  verifyChange,
  verifyPlan,
  verifyPolicy,
  type Verification,
  type VerifyEvent,
} from '../tools/verify.mjs'
import { parseOptions, readConfig, text, UsageError } from './args.mjs'
import { signals } from './until-stopped.mjs'

const USAGE = `recovery-probe verify [--baseline] [--plan FILE] [--out FOLDER]
recovery-probe verify --policy FILE --base REF [--budget MS] [--out FOLDER]`

const HELP = `${USAGE}

Checks a code change with evidence before it is called done. The plan
(.recovery-probe/verify.json by default) lists the checks that prove it:

  { "base": "main", "runs": 3, "checks": [
    { "name": "queue", "command": ["observe", "--config", "observe.json"] } ] }

Run verify --baseline before changing the code, then verify after. It reruns
each check, compares the runs with the baseline, and scans the lines changed
since base for suspects. VERIFIED needs every check improved or clean with
complete runs on both sides, and no suspect on a changed line.

Experimental: --policy reads recovery-probe.policy.json and its registry
scenarios as committed on --base, judges each claim by them, and reports the
candidate's changes to them. The base comes from this command, never a file.
A claim with an app runs on each side's own launch of it. --budget lowers the
policy's overall budget; nothing raises it.

Ctrl+C stops the check in progress, which gets 10 s to clean up. Exit code: 0
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
  else if (event.type === 'planned')
    console.log(
      `The claims can take up to ${minutes(event.worstCaseMs)}, in a budget of ${minutes(event.budgetMs)}`,
    )
  else console.log(`Scanning the lines changed since ${event.base}`)
}

const minutes = (ms: number) => `${Math.ceil(ms / 60000)} min`

interface Request {
  baseline: boolean
  policy?: string
  base?: string
  budgetMs?: number
  plan?: string
  directory?: string
}

/** --budget in milliseconds, which only goes with --policy. */
function budgetOf(value: string | undefined, policy: string | undefined) {
  if (value === undefined) return undefined
  if (!policy) throw new UsageError('--budget goes with --policy')
  const ms = Number(value)
  if (!Number.isInteger(ms) || ms < 1000 || ms > 86400000)
    throw new UsageError('--budget must be 1000–86400000 milliseconds')
  return ms
}

/** What was asked, or a usage error for flags that don't go together. */
function requestOf(args: string[]): Request {
  const { values } = parseOptions(args, {
    baseline: { type: 'boolean' },
    plan: { type: 'string' },
    out: { type: 'string' },
    policy: { type: 'string' },
    base: { type: 'string' },
    budget: { type: 'string' },
  })
  const request = {
    baseline: values.baseline === true,
    policy: text(values, 'policy'),
    base: text(values, 'base'),
    budgetMs: budgetOf(text(values, 'budget'), text(values, 'policy')),
    plan: text(values, 'plan'),
    directory: text(values, 'out'),
  }
  if (!request.policy && request.base)
    throw new UsageError('--base goes with --policy; a plan names its own base')
  if (request.policy && !request.base)
    throw new UsageError(
      '--policy needs --base REF: the base comes from the command, never from a file the change can edit',
    )
  if (request.policy && (request.baseline || request.plan))
    throw new UsageError(
      '--policy replaces the plan and its recorded baseline: leave out --plan and --baseline',
    )
  return request
}

export async function verifyMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const request = requestOf(args)
  const abort = new AbortController()
  const stop = () => {
    if (!abort.signal.aborted)
      console.error('\nStopping: the check in progress gets 10 s to clean up.')
    abort.abort()
  }
  signals.on('SIGINT', stop)
  signals.on('SIGTERM', stop)
  try {
    await verify(request, abort.signal)
  } catch (error) {
    if (!abort.signal.aborted) throw error
    console.error((error as Error).message)
    process.exitCode = 2
  } finally {
    signals.off('SIGINT', stop)
    signals.off('SIGTERM', stop)
  }
}

async function verify(request: Request, signal: AbortSignal) {
  const common = { directory: request.directory, onEvent: print, signal }
  if (request.policy)
    return report(
      await verifyPolicy({
        ...common,
        policy: request.policy,
        base: request.base!,
        budgetMs: request.budgetMs,
      }),
    )
  const plan = await readConfig(
    request.plan ?? '.recovery-probe/verify.json',
    verifyPlan,
  )
  if (!request.baseline) return report(await verifyChange({ ...common, plan }))
  await recordBaseline({ ...common, plan })
  console.log(
    'Baseline recorded. Change the code, then run recovery-probe verify.',
  )
}

function report(result: Verification) {
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
