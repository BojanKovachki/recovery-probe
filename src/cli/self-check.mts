import { PlanInputError } from '../tools/plan/changes.mjs'
import { markdownOf } from '../tools/scenarios/render.mjs'
import {
  selfCheck,
  type SelfCheckOptions,
} from '../tools/scenarios/self-check.mjs'
import {
  integerOption,
  parseOptions,
  text,
  UsageError,
  type Values,
} from './args.mjs'

const USAGE =
  'recovery-probe self-check [NAME...] [--registry FILE] [--run --reference LABEL [--runs N] [--out FOLDER]] [--json]'

const HELP = `${USAGE}

Checks the registered scenarios (recovery-probe.registry.json) before you rely
on them for before/after verification. Experimental.

Without --run it only looks: each check's files, unfilled placeholders, and
its configuration and steps against the validators the command itself uses.
Nothing is started, run or contacted.

--run runs each scenario that passes against the application that is running
now, which you declare with --reference (a commit, version or build you
started; Recovery Probe does not verify which code it is). Each run injects the
faults and performs the actions its configuration names: use a development or
test app. --runs repeats each scenario (3 by default, up to 10), and the
report says whether the runs failed to run, stayed incomplete, disagreed,
found problems on the reference build, or came out clean.

Clean never means the app is correct, the scenario detects its defect, or a
change is VERIFIED. Exit code: 0 every scenario passed (clean with --run), 2
anything to review. Reports: .recovery-probe/self-check. See docs/self-check.md.`

/** The run options, when --run is given, or why the flags don't fit together. */
function runOptions(values: Values): SelfCheckOptions['run'] {
  const reference = text(values, 'reference')
  if (values.run !== true) {
    if (
      reference !== undefined ||
      values.runs !== undefined ||
      values.out !== undefined
    )
      throw new UsageError('--reference, --runs and --out go with --run')
    return undefined
  }
  if (!reference?.trim())
    throw new UsageError(
      '--run needs --reference LABEL: name the build the running application is, such as a commit or version you started',
    )
  return {
    reference,
    runs: integerOption(values, 'runs', [1, 10]),
    directory: text(values, 'out'),
  }
}

export async function selfCheckMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const { values, positionals } = parseOptions(
    args,
    {
      registry: { type: 'string' },
      run: { type: 'boolean' },
      reference: { type: 'string' },
      runs: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
    },
    200,
  )
  const run = runOptions(values)
  if (run)
    console.error(
      `Running the selected scenarios against the application you declared as the reference build: ${run.reference}. Each run injects the faults and performs the actions its configuration names.`,
    )
  try {
    const report = await selfCheck({
      registry: text(values, 'registry'),
      names: positionals,
      run,
    })
    console.log(
      values.json ? JSON.stringify(report, null, 2) : markdownOf(report),
    )
    process.exitCode = report.passed ? 0 : 2
  } catch (error) {
    if (error instanceof PlanInputError) throw new UsageError(error.message)
    throw error
  }
}
