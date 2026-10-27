import type { SuspectPattern } from '../tools/suspects/rules.mjs'
import { scanForSuspects } from '../tools/suspects/scan.mjs'
import { parseOptions, text } from './args.mjs'

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
const MEANING: Record<SuspectPattern, string> = {
  UNKNOWN_AS_EMPTY:
    'a failed or unexpected read becomes an empty collection, so the app cannot tell "unknown" from "none" and may show nothing, or clear or delete what it had.',
  FAILURE_ONLY_LOGGED:
    'a read updates state when it succeeds, but its failure is only logged: the data never arrives, and nothing retries or tells the user.',
}

interface SuspectsOptions {
  paths: string[]
  json?: boolean
  includeTests?: boolean
  changedSince?: string
}

function parseArgs(args: string[]): SuspectsOptions {
  const { values, positionals } = parseOptions(
    args,
    {
      json: { type: 'boolean' },
      'include-tests': { type: 'boolean' },
      'changed-since': { type: 'string' },
    },
    Infinity,
  )
  return {
    paths: positionals,
    json: values.json === true,
    includeTests: values['include-tests'] === true,
    changedSince: text(values, 'changed-since'),
  }
}

export async function suspectsMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const options = parseArgs(args)
  const { scanned, suspects } = await scanForSuspects(options)

  if (options.json) {
    console.log(JSON.stringify({ scanned, suspects }, null, 2))
  } else {
    let current: string | undefined
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
      // Every pattern in the set comes from a suspect in the list.
      const { check } = suspects.find((s) => s.pattern === pattern)!
      console.log(`\n${pattern}: ${MEANING[pattern]}\n  Check: ${check}`)
    }
    console.log(
      `\n${suspects.length} suspect(s) in ${new Set(suspects.map((s) => s.file)).size} file(s); scanned ${scanned}. Suspects are leads: prove or dismiss each with its check, and mark a reviewed line with // recovery-probe-ignore.`,
    )
  }
  process.exitCode = suspects.length ? 2 : 0
}
