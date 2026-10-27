import type * as TS from 'typescript'
import type { CatchCall, SourceTree } from './tree.mjs'

const isWithin = (tree: SourceTree, node: TS.Node, container: TS.Node) =>
  node.getStart(tree.source) >= container.getStart(tree.source) &&
  node.getEnd() <= container.getEnd()

function isErrorCallback(tree: SourceTree, callback: TS.Node) {
  const parent = callback.parent
  return (
    tree.isCatchCall(parent) ||
    (tree.ts.isPropertyAssignment(parent) &&
      /^on(?:Error|Failure)$/.test(parent.name.getText(tree.source)))
  )
}

// `if (Array.isArray(r)) ... else <here>` or `if (!Array.isArray(r)) <here>`
function isNonArrayBranch(
  tree: SourceTree,
  node: TS.Node,
  statement: TS.IfStatement,
) {
  const condition = statement.expression.getText(tree.source)
  if (condition.startsWith('Array.isArray('))
    return Boolean(
      statement.elseStatement && isWithin(tree, node, statement.elseStatement),
    )
  return (
    /^!\s*Array\.isArray\(/.test(condition) &&
    isWithin(tree, node, statement.thenStatement)
  )
}

/** Where a failure lands: catch clauses, `.catch` and `onError` callbacks, non-array branches. */
export function failurePathOf(
  tree: SourceTree,
  node: TS.Node,
): TS.Node | undefined {
  const { ts } = tree
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCatchClause(current)) return current
    if (ts.isFunctionLike(current))
      return isErrorCallback(tree, current) ? current.parent : undefined
    if (ts.isIfStatement(current) && isNonArrayBranch(tree, node, current))
      return current
  }
  return undefined
}

/** The read a `.then(...).catch(...)` chain starts from. */
export function promiseOf(tree: SourceTree, call: CatchCall): TS.Node {
  const { ts } = tree
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
export function readOf(tree: SourceTree, path: TS.Node): TS.Node | undefined {
  const { ts } = tree
  if (ts.isCatchClause(path))
    return ts.isTryStatement(path.parent)
      ? tree.firstAwait(path.parent.tryBlock)
      : undefined
  if (tree.isCatchCall(path)) return promiseOf(tree, path)
  for (let current = path.parent; current; current = current.parent)
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'then'
    )
      return current.expression.expression
  return undefined
}
