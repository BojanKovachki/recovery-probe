import { readFile } from 'node:fs/promises'
import type * as TS from 'typescript'
import { RULES, type Report, type SuspectPattern } from './rules.mjs'
import { SourceTree } from './tree.mjs'

export interface Suspect {
  pattern: SuspectPattern
  file: string
  line: number
  column: number
  /** The flagged line, trimmed. */
  code: string
  why: string
  /** The read whose failure to try, as written in the code, when it can be told. */
  read?: string
  /** How to prove or dismiss the suspect with Recovery Probe. */
  check: string
}

const CHECK: Record<SuspectPattern, string> = {
  UNKNOWN_AS_EMPTY:
    'Fail this read once. Content that disappears (check_read_recovery, discover) or files removed from disk (observe --files) confirm it.',
  FAILURE_ONLY_LOGGED:
    'Fail this read once. If its data never comes back and no error shows (check_read_recovery reports RECOVERY_NOT_OBSERVED), the failure is only logged.',
}

const IGNORE_COMMENT = /recovery-probe-ignore/

const loadTypeScript = async (): Promise<typeof TS> => {
  try {
    // CommonJS: the namespace arrives as `default` from ESM, directly elsewhere.
    const imported = (await import('typescript')) as unknown as typeof TS & {
      default?: typeof TS
    }
    return imported.default ?? imported
  } catch (error) {
    throw new Error(
      `The suspect scanner reads code with TypeScript: npm install --save-dev typescript (${(error as Error).message})`,
      { cause: error },
    )
  }
}

/** Finds the two failure-handling patterns in the given source files. */
export async function findSuspects(files: string[]): Promise<Suspect[]> {
  const ts = await loadTypeScript()
  const suspects: Suspect[] = []
  for (const file of files)
    suspects.push(...scanSource(ts, file, await readFile(file, 'utf8')))
  return suspects
}

const scriptKindOf = (ts: typeof TS, file: string): TS.ScriptKind => {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (['.ts', '.mts', '.cts'].some((end) => file.endsWith(end)))
    return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

export function scanSource(
  ts: typeof TS,
  file: string,
  text: string,
): Suspect[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(ts, file),
  )
  const tree = new SourceTree(ts, source)
  const found: Suspect[] = []
  const report = reporter(file, text.split(/\r?\n/), source, found)
  const visit = (node: TS.Node) => {
    for (const rule of RULES) rule(tree, node, report)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.sort((a, b) => a.line - b.line)
}

/** Adds a suspect to `found`, once per pattern and line, unless a comment dismisses it. */
function reporter(
  file: string,
  lines: string[],
  source: TS.SourceFile,
  found: Suspect[],
): Report {
  const seen = new Set<string>()
  return (pattern, node, why, read) => {
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    )
    const key = `${pattern}:${line}`
    if (seen.has(key)) return
    // A comment on the line or the one above dismisses a reviewed suspect.
    if (
      IGNORE_COMMENT.test(lines[line] ?? '') ||
      IGNORE_COMMENT.test(lines[line - 1] ?? '')
    )
      return
    seen.add(key)
    found.push({
      pattern,
      file,
      line: line + 1,
      column: character + 1,
      code: (lines[line] ?? '').trim().slice(0, 200),
      why,
      ...(read
        ? {
            read: read.getText(source).replace(/\s+/g, ' ').slice(0, 160),
          }
        : {}),
      check: CHECK[pattern],
    })
  }
}
