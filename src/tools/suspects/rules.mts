import type * as TS from 'typescript'
import { failurePathOf, promiseOf, readOf } from './paths.mjs'
import type { SourceTree } from './tree.mjs'

export type SuspectPattern = 'UNKNOWN_AS_EMPTY' | 'FAILURE_ONLY_LOGGED'

/** Records a suspect at `node`; `read` is the read whose failure it is about. */
export type Report = (
  pattern: SuspectPattern,
  node: TS.Node,
  why: string,
  read?: TS.Node,
) => void

/** A rule looks at one node and reports what it finds there. */
type Rule = (tree: SourceTree, node: TS.Node, report: Report) => void

const WHY = {
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

// `(await read()) ?? []`
const defaultAfterAwait: Rule = (tree, node, report) => {
  const { ts } = tree
  if (!ts.isBinaryExpression(node)) return
  const defaults = [
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.BarBarToken,
  ].includes(node.operatorToken.kind)
  const left = tree.unwrap(node.left)
  if (
    defaults &&
    tree.isEmptyCollection(node.right) &&
    ts.isAwaitExpression(left)
  )
    report('UNKNOWN_AS_EMPTY', node, WHY.awaitDefault, left.expression)
}

// `.catch(() => [])`, and `.then(store).catch(log)`
const catchCall: Rule = (tree, node, report) => {
  if (!tree.isCatchCall(node)) return
  const handler = node.arguments[0]
  if (tree.returnsEmpty(handler))
    report(
      'UNKNOWN_AS_EMPTY',
      node.expression.name,
      WHY.catchEmpty,
      promiseOf(tree, node),
    )
  const then = tree.thenCallback(node.expression.expression)
  if (
    then &&
    tree.storesResult(then, tree.resultParameters(then)) &&
    tree.isLogOnly(handler)
  )
    report(
      'FAILURE_ONLY_LOGGED',
      node.expression.name,
      WHY.onlyLogged,
      promiseOf(tree, node),
    )
}

// `catch { return [] }`, and `try { setX(await read()) } catch { log() }`
const tryStatement: Rule = (tree, node, report) => {
  const { ts } = tree
  if (!ts.isTryStatement(node)) return
  const awaited = tree.firstAwait(node.tryBlock)
  if (!awaited || !node.catchClause) return
  const handler = node.catchClause.block
  const empty = handler.statements.find(
    (s) => ts.isReturnStatement(s) && tree.isEmptyCollection(s.expression),
  )
  if (empty) report('UNKNOWN_AS_EMPTY', empty, WHY.catchReturnsEmpty, awaited)
  if (
    tree.storesResult(node.tryBlock, tree.awaitedNames(node.tryBlock)) &&
    tree.isLogOnly(handler)
  )
    report('FAILURE_ONLY_LOGGED', node.catchClause, WHY.onlyLogged, awaited)
}

// A failure path that stores an empty collection.
const storedEmpty: Rule = (tree, node, report) => {
  if (
    !tree.ts.isCallExpression(node) ||
    !tree.isSetter(node) ||
    !node.arguments.some((argument) => tree.holdsEmpty(argument))
  )
    return
  const path = failurePathOf(tree, node)
  if (path)
    report('UNKNOWN_AS_EMPTY', node, WHY.storesEmpty, readOf(tree, path))
}

/** Every rule, in the order they look at a node: a pattern's first report on a line wins. */
export const RULES: Rule[] = [
  defaultAfterAwait,
  catchCall,
  tryStatement,
  storedEmpty,
]
