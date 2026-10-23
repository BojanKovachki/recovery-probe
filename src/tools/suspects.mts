import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type * as TS from 'typescript'

export type SuspectPattern = 'UNKNOWN_AS_EMPTY' | 'FAILURE_ONLY_LOGGED'

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

const WHY: Record<string, string> = {
  awaitDefault:
    'A read that failed or found nothing becomes an empty collection, so code that follows cannot tell "unknown" from "none" and may clear or delete what it has.',
  catchEmpty:
    'A failed read resolves to an empty collection, so the failure looks like "no data".',
  catchReturnsEmpty:
    'The catch returns an empty collection, so a failed read looks like "no data".',
  storesEmpty:
    'A failure path stores an empty collection, so the screen shows "nothing" instead of keeping what it had or showing an error.',
  onlyLogged:
    'The read updates state when it succeeds, but its failure is only logged: the data never arrives, and nothing retries or tells the user.',
}

const CHECK: Record<SuspectPattern, string> = {
  UNKNOWN_AS_EMPTY:
    'Fail this read once. Content that disappears (check_read_recovery, ipc --discover) or files removed from disk (observe --files) confirm it.',
  FAILURE_ONLY_LOGGED:
    'Fail this read once. If its data never comes back and no error shows (check_read_recovery reports RECOVERY_NOT_OBSERVED), the failure is only logged.',
}

// Setters of app state, not of timers or DOM attributes.
const SETTER = /^set(?:State|Self|[A-Z]\w*)?$|^setQueryData$/
const NOT_A_SETTER =
  /^set(?:Timeout|Interval|Immediate|Attribute|Header|Property|RequestHeader|Item|Level|Cookie)$/
const LOG_ONLY_NAME = /log|report|warn|ignore|noop|console|trace|debug/i
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
  const lines = text.split(/\r?\n/)
  const found: Suspect[] = []
  const seen = new Set<string>()

  const unwrap = (node: TS.Node): TS.Node =>
    ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node
  const isEmptyCollection = (node: TS.Node | undefined): boolean => {
    if (!node) return false
    const inner = unwrap(node)
    return (
      (ts.isArrayLiteralExpression(inner) && inner.elements.length === 0) ||
      (ts.isObjectLiteralExpression(inner) && inner.properties.length === 0)
    )
  }
  // `[]`, `{}`, `{ data: [] }` or a function returning one of them.
  const holdsEmpty = (node: TS.Node): boolean => {
    const inner = unwrap(node)
    if (isEmptyCollection(inner)) return true
    if (ts.isObjectLiteralExpression(inner))
      return inner.properties.some(
        (p) => ts.isPropertyAssignment(p) && isEmptyCollection(p.initializer),
      )
    if (ts.isArrowFunction(inner) && !ts.isBlock(inner.body))
      return holdsEmpty(inner.body)
    return false
  }
  const calleeName = (call: TS.CallExpression): string | undefined => {
    const callee = call.expression
    if (ts.isIdentifier(callee)) return callee.text
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text
    return undefined
  }
  const isSetter = (call: TS.CallExpression) => {
    const name = calleeName(call)
    return Boolean(name && SETTER.test(name) && !NOT_A_SETTER.test(name))
  }
  const mentions = (node: TS.Node, names: Set<string>): boolean => {
    if (ts.isIdentifier(node) && names.has(node.text)) return true
    if (ts.isAwaitExpression(node)) return true
    return ts.forEachChild(node, (child) => mentions(child, names)) ?? false
  }
  // Whether `node` stores the read's result: a setter whose arguments use one of
  // `names` (the result) or await it directly. Actions that only toggle a loading
  // flag store nothing they read.
  const storesResult = (node: TS.Node, names: Set<string>): boolean => {
    let found = false
    const visit = (child: TS.Node) => {
      if (found) return
      if (
        ts.isCallExpression(child) &&
        isSetter(child) &&
        child.arguments.some((argument) => mentions(argument, names))
      )
        found = true
      else ts.forEachChild(child, visit)
    }
    visit(node)
    return found
  }
  const boundNames = (names: Set<string>, name: TS.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text)
    else
      for (const element of name.elements)
        if (!ts.isOmittedExpression(element)) boundNames(names, element.name)
    return names
  }
  /** Names a `.then` callback receives the result in. */
  const resultParameters = (callback: TS.Node | undefined) => {
    const names = new Set<string>()
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    )
      for (const parameter of callback.parameters)
        boundNames(names, parameter.name)
    return names
  }
  /** Names a try block assigns awaited results to. */
  const awaitedNames = (block: TS.Block) => {
    const names = new Set<string>()
    const visit = (child: TS.Node) => {
      if (
        ts.isVariableDeclaration(child) &&
        child.initializer &&
        mentions(child.initializer, new Set())
      )
        boundNames(names, child.name)
      if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit)
    }
    visit(block)
    return names
  }
  // A body that does nothing but log: console calls, calls to logging helpers, or nothing.
  const isLogOnly = (node: TS.Node | undefined): boolean => {
    if (!node) return true
    if (ts.isIdentifier(node)) return LOG_ONLY_NAME.test(node.text)
    if (ts.isPropertyAccessExpression(node))
      return LOG_ONLY_NAME.test(node.getText(source))
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      return isLogOnly(node.body)
    if (ts.isBlock(node))
      return node.statements.every(
        (statement) =>
          ts.isExpressionStatement(statement) &&
          isLogOnly(statement.expression),
      )
    const inner = unwrap(node)
    if (ts.isCallExpression(inner))
      return LOG_ONLY_NAME.test(inner.expression.getText(source))
    if (ts.isVoidExpression(inner)) return isLogOnly(inner.expression)
    return false
  }
  const firstAwait = (node: TS.Node): TS.Expression | undefined => {
    let found: TS.Expression | undefined
    const visit = (child: TS.Node) => {
      if (found) return
      if (ts.isAwaitExpression(child)) found = child.expression
      else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit)
    }
    visit(node)
    return found
  }
  type CatchCall = TS.CallExpression & {
    expression: TS.PropertyAccessExpression
  }
  const isCatchCall = (node: TS.Node): node is CatchCall =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'catch'
  const readText = (node: TS.Node | undefined) =>
    node?.getText(source).replace(/\s+/g, ' ').slice(0, 160)

  const add = (
    pattern: SuspectPattern,
    node: TS.Node,
    why: string,
    read?: TS.Node,
  ) => {
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
      ...(read ? { read: readText(read) } : {}),
      check: CHECK[pattern],
    })
  }

  const isWithin = (node: TS.Node, container: TS.Node) =>
    node.getStart(source) >= container.getStart(source) &&
    node.getEnd() <= container.getEnd()
  const isErrorCallback = (callback: TS.Node) => {
    const parent = callback.parent
    return (
      isCatchCall(parent) ||
      (ts.isPropertyAssignment(parent) &&
        /^on(?:Error|Failure)$/.test(parent.name.getText(source)))
    )
  }
  // `if (Array.isArray(r)) ... else <here>` or `if (!Array.isArray(r)) <here>`
  const isNonArrayBranch = (node: TS.Node, statement: TS.IfStatement) => {
    const condition = statement.expression.getText(source)
    if (condition.startsWith('Array.isArray('))
      return Boolean(
        statement.elseStatement && isWithin(node, statement.elseStatement),
      )
    return (
      /^!\s*Array\.isArray\(/.test(condition) &&
      isWithin(node, statement.thenStatement)
    )
  }
  /** Where a failure lands: catch clauses, `.catch` and `onError` callbacks, non-array branches. */
  const failurePathOf = (node: TS.Node): TS.Node | undefined => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isCatchClause(current)) return current
      if (ts.isFunctionLike(current))
        return isErrorCallback(current) ? current.parent : undefined
      if (ts.isIfStatement(current) && isNonArrayBranch(node, current))
        return current
    }
    return undefined
  }
  // The read a `.then(...).catch(...)` chain starts from.
  const promiseOf = (call: CatchCall): TS.Node => {
    let receiver = call.expression.expression
    while (
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      ['then', 'catch', 'finally'].includes(receiver.expression.name.text)
    )
      receiver = receiver.expression.expression
    return receiver
  }
  /** The read a failure path belongs to: the promise before `.then`/`.catch`, or the awaited call. */
  const readOf = (path: TS.Node): TS.Node | undefined => {
    if (ts.isCatchClause(path))
      return ts.isTryStatement(path.parent)
        ? firstAwait(path.parent.tryBlock)
        : undefined
    if (isCatchCall(path)) return promiseOf(path)
    for (let current = path.parent; current; current = current.parent)
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === 'then'
      )
        return current.expression.expression
    return undefined
  }
  const returnsEmpty = (callback: TS.Node | undefined) => {
    if (
      !callback ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    )
      return false
    return ts.isBlock(callback.body)
      ? callback.body.statements.some(
          (s) => ts.isReturnStatement(s) && isEmptyCollection(s.expression),
        )
      : isEmptyCollection(callback.body)
  }

  // `(await read()) ?? []`
  const checkDefaultAfterAwait = (node: TS.BinaryExpression) => {
    const defaults = [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
    ].includes(node.operatorToken.kind)
    const left = unwrap(node.left)
    if (defaults && isEmptyCollection(node.right) && ts.isAwaitExpression(left))
      add('UNKNOWN_AS_EMPTY', node, WHY.awaitDefault, left.expression)
  }

  // `.catch(() => [])`, and `.then(store).catch(log)`
  const checkCatchCall = (node: CatchCall) => {
    const handler = node.arguments[0]
    if (returnsEmpty(handler))
      add(
        'UNKNOWN_AS_EMPTY',
        node.expression.name,
        WHY.catchEmpty,
        promiseOf(node),
      )
    const receiver = node.expression.expression
    const then =
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === 'then'
        ? receiver.arguments[0]
        : undefined
    if (
      then &&
      storesResult(then, resultParameters(then)) &&
      isLogOnly(handler)
    )
      add(
        'FAILURE_ONLY_LOGGED',
        node.expression.name,
        WHY.onlyLogged,
        promiseOf(node),
      )
  }

  // `catch { return [] }`, and `try { setX(await read()) } catch { log() }`
  const checkTry = (node: TS.TryStatement) => {
    const awaited = firstAwait(node.tryBlock)
    if (!awaited || !node.catchClause) return
    const handler = node.catchClause.block
    const empty = handler.statements.find(
      (s) => ts.isReturnStatement(s) && isEmptyCollection(s.expression),
    )
    if (empty) add('UNKNOWN_AS_EMPTY', empty, WHY.catchReturnsEmpty, awaited)
    if (
      storesResult(node.tryBlock, awaitedNames(node.tryBlock)) &&
      isLogOnly(handler)
    )
      add('FAILURE_ONLY_LOGGED', node.catchClause, WHY.onlyLogged, awaited)
  }

  // A failure path that stores an empty collection.
  const checkStoredEmpty = (node: TS.CallExpression) => {
    if (!isSetter(node) || !node.arguments.some(holdsEmpty)) return
    const path = failurePathOf(node)
    if (path) add('UNKNOWN_AS_EMPTY', node, WHY.storesEmpty, readOf(path))
  }

  const visit = (node: TS.Node) => {
    if (ts.isBinaryExpression(node)) checkDefaultAfterAwait(node)
    if (isCatchCall(node)) checkCatchCall(node)
    if (ts.isTryStatement(node)) checkTry(node)
    if (ts.isCallExpression(node)) checkStoredEmpty(node)
    ts.forEachChild(node, visit)
  }

  visit(source)
  return found.sort((a, b) => a.line - b.line)
}

const SOURCE = /\.[cm]?[jt]sx?$/
const DECLARATION = /\.d\.[cm]?ts$/
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  '.recovery-probe',
])
const TEST_FILE =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])(?:__tests__|__mocks__)[\\/]/

export const isScannable = (path: string, includeTests: boolean) =>
  SOURCE.test(path) &&
  !DECLARATION.test(path) &&
  (includeTests || !TEST_FILE.test(path))

/** The source files under the given files and directories. */
export async function sourceFiles(
  paths: string[],
  { includeTests = false }: { includeTests?: boolean } = {},
): Promise<string[]> {
  const files: string[] = []
  const walk = async (path: string) => {
    if ((await stat(path)).isFile()) {
      if (isScannable(path, includeTests)) files.push(path)
      return
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name))
          await walk(join(path, entry.name))
      } else if (
        entry.isFile() &&
        isScannable(join(path, entry.name), includeTests)
      )
        files.push(join(path, entry.name))
    }
  }
  for (const path of paths) await walk(path)
  return files
}

const git = (cwd: string, args: string[]) =>
  promisify(execFile)('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout }) => stdout.split('\n').filter(Boolean),
  )

const untrackedFiles = (cwd: string) =>
  git(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name'])

// Relative to cwd, so paths keep its spelling, such as a Windows short name.
const repositoryRoot = async (cwd: string) =>
  resolve(cwd, (await git(cwd, ['rev-parse', '--show-cdup']))[0] ?? '')

/** Source files changed since `ref` in the Git work tree around `cwd`, including uncommitted and untracked ones. */
export async function changedSourceFiles(
  ref: string,
  {
    cwd = process.cwd(),
    includeTests = false,
  }: { cwd?: string; includeTests?: boolean } = {},
): Promise<string[]> {
  const root = await repositoryRoot(cwd)
  const changed = new Set([
    ...(await git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', ref])),
    ...(await untrackedFiles(cwd)),
  ])
  return [...changed]
    .map((path) => resolve(root, path))
    .filter((path) => isScannable(path, includeTests) && existsSync(path))
}

/**
 * The lines added or changed since `ref`, by absolute path, including
 * uncommitted changes. `true` stands for an untracked file, new as a whole.
 */
export async function changedLines(
  ref: string,
  { cwd = process.cwd() }: { cwd?: string } = {},
): Promise<Map<string, Set<number> | true>> {
  const root = await repositoryRoot(cwd)
  const diff = await git(cwd, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--diff-filter=ACMR',
    ref,
  ])
  const changed = new Map<string, Set<number> | true>()
  let lines: Set<number> | undefined
  // "+++ " names the file only in a file header, never in a hunk.
  let inHeader = false
  for (const line of diff) {
    if (line.startsWith('diff --git ')) inHeader = true
    else if (inHeader && line.startsWith('+++ b/')) {
      lines = new Set()
      changed.set(resolve(root, line.slice('+++ b/'.length)), lines)
    } else if (line.startsWith('@@ ')) {
      inHeader = false
      const [, start, count = '1'] =
        /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line) ?? []
      for (let n = Number(start); n < Number(start) + Number(count); n++)
        lines?.add(n)
    }
  }
  for (const path of await untrackedFiles(cwd))
    changed.set(resolve(root, path), true)
  return changed
}

export interface SuspectScan {
  /** How many source files were read. */
  scanned: number
  /** File names are relative to the working directory, with forward slashes. */
  suspects: Suspect[]
}

/**
 * Scans the given files and directories (default: the working directory), or
 * only the files changed since `changedSince`; with both, the changed files
 * under the given paths. `changedLinesOnly` also leaves out suspects on lines
 * the change did not touch.
 */
export async function scanForSuspects({
  paths = [],
  changedSince,
  changedLinesOnly = false,
  includeTests = false,
}: {
  paths?: string[]
  changedSince?: string
  changedLinesOnly?: boolean
  includeTests?: boolean
} = {}): Promise<SuspectScan> {
  if (changedLinesOnly && !changedSince)
    throw new Error('changedLinesOnly needs changedSince')
  let files = changedSince
    ? await changedSourceFiles(changedSince, { includeTests })
    : await sourceFiles(paths.length ? paths : ['.'], { includeTests })
  if (changedSince && paths.length) {
    const wanted = new Set(
      (await sourceFiles(paths, { includeTests })).map((path) => resolve(path)),
    )
    files = files.filter((path) => wanted.has(resolve(path)))
  }
  let found = await findSuspects(files)
  if (changedLinesOnly) {
    const changed = await changedLines(changedSince!)
    found = found.filter((suspect) => {
      const lines = changed.get(resolve(suspect.file))
      return lines === true || lines?.has(suspect.line)
    })
  }
  const suspects = found.map((suspect) => ({
    ...suspect,
    file: relative('.', suspect.file).split(sep).join('/'),
  }))
  return { scanned: files.length, suspects }
}
