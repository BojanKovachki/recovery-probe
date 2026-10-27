import type * as TS from 'typescript'

// Setters of app state, not of timers or DOM attributes.
const SETTER = /^set(?:State|Self|[A-Z]\w*)?$|^setQueryData$/
const NOT_A_SETTER =
  /^set(?:Timeout|Interval|Immediate|Attribute|Header|Property|RequestHeader|Item|Level|Cookie)$/
const LOG_ONLY_NAME = /log|report|warn|ignore|noop|console|trace|debug/i

export type CatchCall = TS.CallExpression & {
  expression: TS.PropertyAccessExpression
}

/** One parsed source file and the questions the rules ask about its nodes. */
export class SourceTree {
  readonly ts: typeof TS
  readonly source: TS.SourceFile

  constructor(ts: typeof TS, source: TS.SourceFile) {
    this.ts = ts
    this.source = source
  }

  unwrap(node: TS.Node): TS.Node {
    return this.ts.isParenthesizedExpression(node)
      ? this.unwrap(node.expression)
      : node
  }

  isEmptyCollection(node: TS.Node | undefined): boolean {
    if (!node) return false
    const { ts } = this
    const inner = this.unwrap(node)
    return (
      (ts.isArrayLiteralExpression(inner) && inner.elements.length === 0) ||
      (ts.isObjectLiteralExpression(inner) && inner.properties.length === 0)
    )
  }

  /** `[]`, `{}`, `{ data: [] }` or a function returning one of them. */
  holdsEmpty(node: TS.Node): boolean {
    const { ts } = this
    const inner = this.unwrap(node)
    if (this.isEmptyCollection(inner)) return true
    if (ts.isObjectLiteralExpression(inner))
      return inner.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) && this.isEmptyCollection(p.initializer),
      )
    if (ts.isArrowFunction(inner) && !ts.isBlock(inner.body))
      return this.holdsEmpty(inner.body)
    return false
  }

  isSetter(call: TS.CallExpression): boolean {
    const name = this.#calleeName(call)
    return Boolean(name && SETTER.test(name) && !NOT_A_SETTER.test(name))
  }

  #calleeName(call: TS.CallExpression): string | undefined {
    const { ts } = this
    const callee = call.expression
    if (ts.isIdentifier(callee)) return callee.text
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text
    return undefined
  }

  /** Whether `node` uses one of `names` or awaits something. */
  mentions(node: TS.Node, names: Set<string>): boolean {
    const { ts } = this
    if (ts.isIdentifier(node) && names.has(node.text)) return true
    if (ts.isAwaitExpression(node)) return true
    return (
      ts.forEachChild(node, (child) => this.mentions(child, names)) ?? false
    )
  }

  // Whether `node` stores the read's result: a setter whose arguments use one of
  // `names` (the result) or await it directly. Actions that only toggle a loading
  // flag store nothing they read.
  storesResult(node: TS.Node, names: Set<string>): boolean {
    const { ts } = this
    let found = false
    const visit = (child: TS.Node) => {
      if (found) return
      if (
        ts.isCallExpression(child) &&
        this.isSetter(child) &&
        child.arguments.some((argument) => this.mentions(argument, names))
      )
        found = true
      else ts.forEachChild(child, visit)
    }
    visit(node)
    return found
  }

  #boundNames(names: Set<string>, name: TS.BindingName): Set<string> {
    const { ts } = this
    if (ts.isIdentifier(name)) names.add(name.text)
    else
      for (const element of name.elements)
        if (!ts.isOmittedExpression(element))
          this.#boundNames(names, element.name)
    return names
  }

  /** Names a `.then` callback receives the result in. */
  resultParameters(callback: TS.Node | undefined): Set<string> {
    const { ts } = this
    const names = new Set<string>()
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    )
      for (const parameter of callback.parameters)
        this.#boundNames(names, parameter.name)
    return names
  }

  /** Names a try block assigns awaited results to. */
  awaitedNames(block: TS.Block): Set<string> {
    const { ts } = this
    const names = new Set<string>()
    const visit = (child: TS.Node) => {
      if (
        ts.isVariableDeclaration(child) &&
        child.initializer &&
        this.mentions(child.initializer, new Set())
      )
        this.#boundNames(names, child.name)
      if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit)
    }
    visit(block)
    return names
  }

  /** A body that does nothing but log: console calls, calls to logging helpers, or nothing. */
  isLogOnly(node: TS.Node | undefined): boolean {
    const { ts, source } = this
    if (!node) return true
    if (ts.isIdentifier(node)) return LOG_ONLY_NAME.test(node.text)
    if (ts.isPropertyAccessExpression(node))
      return LOG_ONLY_NAME.test(node.getText(source))
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      return this.isLogOnly(node.body)
    if (ts.isBlock(node))
      return node.statements.every(
        (statement) =>
          ts.isExpressionStatement(statement) &&
          this.isLogOnly(statement.expression),
      )
    const inner = this.unwrap(node)
    if (ts.isCallExpression(inner))
      return LOG_ONLY_NAME.test(inner.expression.getText(source))
    if (ts.isVoidExpression(inner)) return this.isLogOnly(inner.expression)
    return false
  }

  firstAwait(node: TS.Node): TS.Expression | undefined {
    const { ts } = this
    let found: TS.Expression | undefined
    const visit = (child: TS.Node) => {
      if (found) return
      if (ts.isAwaitExpression(child)) found = child.expression
      else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit)
    }
    visit(node)
    return found
  }

  isCatchCall(node: TS.Node): node is CatchCall {
    const { ts } = this
    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch'
    )
  }

  /** The callback `receiver` passes when it is a `.then(...)` call. */
  thenCallback(receiver: TS.Node): TS.Expression | undefined {
    const { ts } = this
    return ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === 'then'
      ? receiver.arguments[0]
      : undefined
  }

  /** Whether a callback returns an empty collection. */
  returnsEmpty(callback: TS.Node | undefined): boolean {
    const { ts } = this
    if (
      !callback ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    )
      return false
    return ts.isBlock(callback.body)
      ? callback.body.statements.some(
          (s) =>
            ts.isReturnStatement(s) && this.isEmptyCollection(s.expression),
        )
      : this.isEmptyCollection(callback.body)
  }
}
