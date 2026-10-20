import { scanForSuspects } from '../dist/suspects.mjs'

const USAGE =
  'recovery-probe suspects [PATH...] [--changed-since REF] [--include-tests] [--json]'

const HELP = `${USAGE}

Reads JavaScript and TypeScript sources for failure handling that loses data:
UNKNOWN_AS_EMPTY (a failed or unexpected read becomes an empty collection) and
FAILURE_ONLY_LOGGED (a read's failure is only logged, so its data never arrives).
Each suspect names the read to fail and the check that proves or dismisses it.
Suspects are leads, not bugs. --changed-since main scans only what a branch changed.
Mark a reviewed line with // recovery-probe-ignore. Exit 0: none; 2: suspects to
review. Needs TypeScript in the project. See docs/suspects.md.`

// Each suspect's own `why` is in --json; the summary explains the pattern once.
const MEANING = {
  UNKNOWN_AS_EMPTY:
    'a failed or unexpected read becomes an empty collection, so the app cannot tell "unknown" from "none" and may show nothing, or clear or delete what it had.',
  FAILURE_ONLY_LOGGED:
    'a read updates state when it succeeds, but its failure is only logged: the data never arrives, and nothing retries or tells the user.',
}

function parseArgs(args) {
  const options = { paths: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') options.json = true
    else if (arg === '--include-tests') options.includeTests = true
    else if (arg === '--changed-since') {
      if (!args[i + 1] || args[i + 1].startsWith('--'))
        throw Error('--changed-since needs a Git reference, such as main')
      options.changedSince = args[++i]
    } else if (arg.startsWith('--')) throw Error(`Use ${USAGE}`)
    else options.paths.push(arg)
  }
  return options
}

export async function suspectsMain(args) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const options = parseArgs(args)
  const { scanned, suspects } = await scanForSuspects(options)

  if (options.json) {
    console.log(JSON.stringify({ scanned, suspects }, null, 2))
  } else {
    let current
    for (const suspect of suspects) {
      if (suspect.file !== current) {
        current = suspect.file
        console.log(`\n${current}`)
      }
      console.log(
        `  ${String(suspect.line).padStart(5)}  ${suspect.pattern}${suspect.read ? `  read: ${suspect.read}` : ''}`,
      )
      console.log(`         ${suspect.code}`)
    }
    for (const pattern of new Set(suspects.map((s) => s.pattern))) {
      const { check } = suspects.find((s) => s.pattern === pattern)
      console.log(`\n${pattern}: ${MEANING[pattern]}\n  Check: ${check}`)
    }
    console.log(
      `\n${suspects.length} suspect(s) in ${new Set(suspects.map((s) => s.file)).size} file(s); scanned ${scanned}. Suspects are leads: prove or dismiss each with its check, and mark a reviewed line with // recovery-probe-ignore.`,
    )
  }
  process.exitCode = suspects.length ? 2 : 0
}
