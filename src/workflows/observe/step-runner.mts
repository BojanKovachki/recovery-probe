import type { Locator, Page } from 'playwright'
import type { SelectorSpec } from '../../core/selector.mjs'
import type {
  FileStepControl,
  NetworkStepControl,
  ObservationStep,
  StepResult,
} from './steps.mjs'

export interface RunStepsOptions {
  mark: () => Promise<number | null>
  signal: AbortSignal
  elapsed: () => number
  log?: (result: StepResult) => void
  network?: NetworkStepControl
  files?: FileStepControl
}

/** A step that acts on or waits for an element: click, fill, press, waitFor or expect. */
type TargetStep = Extract<ObservationStep, { timeoutMs: number }>

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function locate(page: Page, spec: SelectorSpec): Locator {
  if (typeof spec === 'string') return page.locator(spec)
  let locator = spec.css ? page.locator(spec.css) : null
  if (spec.role) {
    const byRole = page.getByRole(
      spec.role as Parameters<Page['getByRole']>[0],
      spec.name === undefined ? {} : { name: spec.name, exact: true },
    )
    locator = locator ? locator.and(byRole) : byRole
  }
  // Validated selectors always have css or role.
  if (!locator) throw Error('A selector needs css or role')
  if (spec.text !== undefined)
    locator = locator.filter({
      hasText: new RegExp(`^\\s*${escapeRegExp(spec.text)}\\s*$`),
    })
  return locator
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

/** `false` when Playwright gave up waiting; any other error still fails the step. */
const shownInTime = (waiting: Promise<void>): Promise<boolean> =>
  waiting.then(
    () => true,
    (error: Error) => {
      if (error.name === 'TimeoutError') return false
      throw error
    },
  )

/** Runs steps in order. Clicks, typing and key presses require exactly one visible match and use real input events. */
export async function runSteps(
  page: Page,
  steps: ObservationStep[],
  options: RunStepsOptions,
): Promise<StepResult[]> {
  const { elapsed, log = () => {} } = options
  const results: StepResult[] = []
  for (const [index, step] of steps.entries()) {
    const result: StepResult = {
      index,
      kind: step.kind,
      ...(step.name ? { name: step.name } : {}),
      startedMs: elapsed(),
    }
    results.push(result)
    try {
      await runStep(page, step, result, options)
      result.status ??= 'done'
    } catch (error) {
      result.status = 'failed'
      result.error = String((error as Error).message)
        .split('\n')[0]
        .slice(0, 300)
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

/** Runs one step; an `expect` step that saw nothing in time marks `result` unmet. */
async function runStep(
  page: Page,
  step: ObservationStep,
  result: StepResult,
  { mark, signal, network, files }: RunStepsOptions,
) {
  const index = result.index
  switch (step.kind) {
    case 'mark':
      result.interval = await abortable(mark(), signal)
      return
    case 'navigate':
      await abortable(
        page.evaluate((fragment) => {
          location.hash = fragment
        }, step.target),
        signal,
      )
      return
    case 'wait':
      await abortable(
        new Promise((resolve) => setTimeout(resolve, step.ms)),
        signal,
      )
      return
    case 'network':
      if (!network) throw Error('NETWORK_CONTROL_MISSING')
      await abortable(
        step.rules ? network.arm(step.rules, index) : network.restore(index),
        signal,
      )
      return
    case 'file':
      if (!files) throw Error('FILE_CONTROL_MISSING')
      await abortable(files.damage(step.path, step.fault, index), signal)
      return
    case 'waitFor':
    case 'expect':
      return waitForVisible(page, step, result, signal)
    default:
      return actOnTarget(page, step, signal)
  }
}

async function waitForVisible(
  page: Page,
  step: TargetStep,
  result: StepResult,
  signal: AbortSignal,
) {
  const visible = locate(page, step.target)
    .filter({ visible: true })
    .first()
    .waitFor({ state: 'visible', timeout: step.timeoutMs })
  if (step.kind === 'waitFor') {
    await abortable(visible, signal)
    return
  }
  // What the app failed to show is a result, so the script goes on.
  if (!(await abortable(shownInTime(visible), signal))) {
    result.status = 'unmet'
    result.error = `EXPECTATION_NOT_MET: no visible match within ${step.timeoutMs} ms`
  }
}

async function actOnTarget(page: Page, step: TargetStep, signal: AbortSignal) {
  const target = locate(page, step.target).filter({ visible: true })
  const count = await abortable(target.count(), signal)
  if (count !== 1)
    throw Error(
      `STEP_TARGET_NOT_UNIQUE: expected exactly one visible match, found ${count}`,
    )
  await abortable(act(target, step), signal)
}

function act(target: Locator, step: TargetStep) {
  const timeout = { timeout: step.timeoutMs }
  if (step.kind === 'fill') return target.fill(step.value, timeout)
  if (step.kind === 'press') return target.press(step.key, timeout)
  return target.click(timeout)
}
