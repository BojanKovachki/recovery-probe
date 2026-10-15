import { selectorSpec } from './observation-kit.mjs'

// Opt-in scripted operator for `observe --steps`. Steps act on the app (same-document
// navigation, clicks, waits and interval marks); observation itself never acts.
const NAME = /^[\w.-]{1,40}$/
const KINDS = ['mark', 'navigate', 'click', 'waitFor', 'wait']

export function observationSteps(input) {
  const steps = Array.isArray(input) ? input : input?.steps
  if (!Array.isArray(steps) || !steps.length || steps.length > 50)
    throw Error('steps must list 1–50 steps')
  return steps.map((step, i) => {
    if (!step || typeof step !== 'object' || Array.isArray(step))
      throw Error(`steps[${i}] must be an object`)
    const kinds = KINDS.filter((k) => Object.hasOwn(step, k))
    if (kinds.length !== 1)
      throw Error(`steps[${i}] needs exactly one of ${KINDS.join(', ')}`)
    const [kind] = kinds
    for (const key of Object.keys(step))
      if (![kind, 'name', 'timeoutMs'].includes(key))
        throw Error(`Unsupported steps[${i}] property: ${key}`)
    if (
      step.name !== undefined &&
      (typeof step.name !== 'string' || !NAME.test(step.name))
    )
      throw Error(`steps[${i}].name must match ${NAME}`)
    const timeoutMs = step.timeoutMs ?? (kind === 'waitFor' ? 15000 : 10000)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      throw Error(`steps[${i}].timeoutMs must be 100–60000`)
    const named = step.name ? { name: step.name } : {}
    if (kind === 'mark') {
      if (step.mark !== true) throw Error(`steps[${i}].mark must be true`)
      return { kind, ...named }
    }
    if (kind === 'navigate') {
      // Same-document fragment navigation only: a document load would reset the state under observation.
      if (
        typeof step.navigate !== 'string' ||
        !/^#\S{0,500}$/.test(step.navigate)
      )
        throw Error(`steps[${i}].navigate must be a same-document #fragment`)
      return { kind, target: step.navigate, ...named }
    }
    if (kind === 'wait') {
      if (!Number.isInteger(step.wait) || step.wait < 0 || step.wait > 60000)
        throw Error(`steps[${i}].wait must be 0–60000 ms`)
      return { kind, ms: step.wait, ...named }
    }
    return {
      kind,
      target: selectorSpec(step[kind], `steps[${i}].${kind}`),
      timeoutMs,
      ...named,
    }
  })
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function locate(page, spec) {
  if (typeof spec === 'string') return page.locator(spec)
  let locator = spec.css ? page.locator(spec.css) : null
  if (spec.role) {
    const byRole = page.getByRole(
      spec.role,
      spec.name === undefined ? {} : { name: spec.name, exact: true },
    )
    locator = locator ? locator.and(byRole) : byRole
  }
  if (spec.text !== undefined)
    locator = locator.filter({
      hasText: new RegExp(`^\\s*${escapeRegExp(spec.text)}\\s*$`),
    })
  return locator
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Error('STEPS_STOPPED'))
      return
    }
    const stop = () => reject(Error('STEPS_STOPPED'))
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

/** Runs steps in order. Clicks require exactly one visible match and use real input events. */
export async function runSteps(
  page,
  steps,
  { mark, signal, elapsed, log = () => {} },
) {
  const results = []
  for (const [index, step] of steps.entries()) {
    const result = {
      index,
      kind: step.kind,
      ...(step.name ? { name: step.name } : {}),
      startedMs: elapsed(),
    }
    results.push(result)
    try {
      if (step.kind === 'mark')
        result.interval = await abortable(mark(), signal)
      else if (step.kind === 'navigate')
        await abortable(
          page.evaluate((fragment) => {
            location.hash = fragment
          }, step.target),
          signal,
        )
      else if (step.kind === 'wait')
        await abortable(
          new Promise((resolve) => setTimeout(resolve, step.ms)),
          signal,
        )
      else if (step.kind === 'waitFor')
        await abortable(
          locate(page, step.target)
            .filter({ visible: true })
            .first()
            .waitFor({ state: 'visible', timeout: step.timeoutMs }),
          signal,
        )
      else {
        const target = locate(page, step.target).filter({ visible: true })
        const count = await abortable(target.count(), signal)
        if (count !== 1)
          throw Error(
            `STEP_TARGET_NOT_UNIQUE: expected exactly one visible match, found ${count}`,
          )
        await abortable(target.click({ timeout: step.timeoutMs }), signal)
      }
      result.status = 'done'
    } catch (error) {
      result.status = 'failed'
      result.error = String(error.message).split('\n')[0].slice(0, 300)
      throw Object.assign(
        Error(`Step ${index} (${step.kind}) failed: ${result.error}`),
        { results },
      )
    } finally {
      result.endedMs = elapsed()
      log(result)
    }
  }
  return results
}
