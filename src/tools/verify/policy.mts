import {
  ensure,
  isIntegerIn,
  isNonEmptyString,
  isRecord,
} from '../../core/validate.mjs'
import { safeRelativePath } from '../plan/paths.mjs'
import { validateCommand } from '../process.mjs'

export const POLICY_SCHEMA = 'recovery-probe/policy@1'
export const DEFAULT_POLICY = 'recovery-probe.policy.json'

const NAME = /^[\w.-]{1,40}$/
const KEYS = [
  'schema',
  'runs',
  'setup',
  'projectChecks',
  'claims',
  'apps',
  'budgets',
  'ignore',
  'env',
  'testFiles',
]

/** Where tests usually live, used when a policy doesn't name its own. */
export const DEFAULT_TEST_FILES = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
]

/** Whether an input names files by a pattern, such as `test/**`, rather than one file. */
export const isPattern = (input: string) => /[*?]/.test(input)

export interface ProjectCheck {
  id: string
  command: string[]
  /**
   * Files, patterns such as `test/**`, or `file#a.b` for one JSON value, whose candidate
   * changes need approval.
   */
  inputs: string[]
  timeoutMs: number
  attempts: number
}

export interface PolicyClaim {
  id: string
  /** Registry scenarios: one fails a read, the other checks the same screen without a fault. */
  failurePath: string
  normalPath: string
  /** `expect` steps that must be met on both paths. */
  assertions: string[]
  /** The app this policy launches for the claim; without it, someone started it by hand. */
  app?: string
}

export interface PolicyApp {
  setup: string[][]
  launch: string[]
  url: string
  ready: { url: string; timeoutMs: number }
  fixtures: string[]
}

/** What the owner approved on the base: commands, launches, budgets, claims and ignore rules. */
export interface Policy {
  schema: typeof POLICY_SCHEMA
  /** Runs of each scenario. */
  runs: number
  setup: string[][]
  projectChecks: ProjectCheck[]
  claims: PolicyClaim[]
  apps: Record<string, PolicyApp>
  budgets: { totalMs: number; scenarioRunMs: number; cleanupReserveMs: number }
  /** Changed files that need no claim, as registry-style patterns. */
  ignore: string[]
  /** Variables setup and project checks get from verify's own environment, by name. */
  env: string[]
  /**
   * Test files, as patterns. They're criteria: a changed or deleted one needs approval on the
   * base, while an added one only shows for review.
   */
  testFiles: string[]
}

const commands = (value: unknown, where: string) => {
  ensure(Array.isArray(value), `${where} must be a list of commands`)
  return (value as unknown[]).map((command, i) => {
    try {
      return validateCommand(command)
    } catch (error) {
      throw new Error(`${where}[${i}]: ${(error as Error).message}`, {
        cause: error,
      })
    }
  })
}

const names = (value: unknown, where: string, pattern = NAME) => {
  ensure(
    Array.isArray(value) && value.every((name) => pattern.test(String(name))),
    `${where} must list names matching ${pattern}`,
  )
  return value as string[]
}

const isInput = (value: unknown) => {
  if (typeof value !== 'string') return false
  const [path, selector, ...rest] = value.split('#')
  return (
    !rest.length &&
    safeRelativePath(path) !== undefined &&
    (selector === undefined ||
      (!isPattern(path) && /^\w[\w-]*(\.\w[\w-]*)*$/.test(selector)))
  )
}

const patterns = (value: unknown, where: string) => {
  ensure(
    Array.isArray(value) &&
      value.every((pattern) => safeRelativePath(String(pattern))),
    `${where} must list relative file patterns`,
  )
  return value as string[]
}

const listOf = <T,>(
  value: unknown,
  where: string,
  read: (item: Record<string, unknown>, at: string) => T,
) => {
  ensure(
    value === undefined || (Array.isArray(value) && value.length <= 50),
    `${where} must list at most 50 entries`,
  )
  const items = ((value ?? []) as unknown[]).map((item, i) => {
    ensure(isRecord(item), `${where}[${i}] must be an object`)
    return read(item as Record<string, unknown>, `${where}[${i}]`)
  })
  const ids = items.map((item) => (item as { id: string }).id)
  const twice = ids.find((id, i) => ids.indexOf(id) !== i)
  ensure(!twice, `${where} uses the id ${twice} twice`)
  return items
}

function projectCheck(item: Record<string, unknown>, at: string): ProjectCheck {
  const { id, command, inputs = [], timeoutMs, attempts = 1 } = item
  ensure(typeof id === 'string' && NAME.test(id), `${at}.id must match ${NAME}`)
  ensure(
    Array.isArray(inputs) && inputs.every(isInput),
    `${at}.inputs must list relative files, each optionally with #a.b for one JSON value, or patterns such as test/**`,
  )
  ensure(
    isIntegerIn(timeoutMs, 1000, 3600000),
    `${at}.timeoutMs is required: 1000–3600000 ms`,
  )
  ensure(isIntegerIn(attempts, 1, 3), `${at}.attempts must be 1–3`)
  return {
    id,
    command: commands([command], `${at}.command`)[0],
    inputs: inputs as string[],
    timeoutMs: timeoutMs as number,
    attempts: attempts as number,
  }
}

function claim(item: Record<string, unknown>, at: string): PolicyClaim {
  const { id, failurePath, normalPath, assertions = [], app } = item
  ensure(typeof id === 'string' && NAME.test(id), `${at}.id must match ${NAME}`)
  const [failure, normal] = names([failurePath, normalPath], `${at}'s paths`)
  ensure(app === undefined || isNonEmptyString(app), `${at}.app must be a name`)
  return {
    id,
    failurePath: failure,
    normalPath: normal,
    assertions: names(assertions, `${at}.assertions`),
    ...(app === undefined ? {} : { app: app as string }),
  }
}

function app(value: unknown, at: string): PolicyApp {
  ensure(isRecord(value), `${at} must be an object`)
  const {
    setup = [],
    launch,
    url,
    ready,
    fixtures = [],
  } = value as Record<string, unknown>
  ensure(isNonEmptyString(url), `${at}.url must be the app's address`)
  ensure(
    isRecord(ready) &&
      isNonEmptyString(ready.url) &&
      isIntegerIn(ready.timeoutMs, 1000, 600000),
    `${at}.ready must be { url, timeoutMs }`,
  )
  ensure(
    Array.isArray(fixtures) &&
      fixtures.every((path) => safeRelativePath(String(path))),
    `${at}.fixtures must list relative files`,
  )
  return {
    setup: commands(setup, `${at}.setup`),
    launch: commands([launch], `${at}.launch`)[0],
    url: url as string,
    ready: ready as PolicyApp['ready'],
    fixtures: fixtures as string[],
  }
}

function budgets(value: unknown): Policy['budgets'] {
  ensure(value === undefined || isRecord(value), 'budgets must be an object')
  const given = (value ?? {}) as Record<string, unknown>
  const result = {
    totalMs: given.totalMs ?? 1800000,
    scenarioRunMs: given.scenarioRunMs ?? 300000,
    cleanupReserveMs: given.cleanupReserveMs ?? 60000,
  }
  for (const [key, ms] of Object.entries(result))
    ensure(
      isIntegerIn(ms, 1000, 86400000),
      `budgets.${key} must be 1000–86400000 ms`,
    )
  ensure(
    result.scenarioRunMs <= result.totalMs &&
      result.cleanupReserveMs < result.totalMs,
    'budgets: a scenario run and the cleanup reserve must fit in totalMs',
  )
  return result as Policy['budgets']
}

/** The policy, or the first thing wrong with it. Unknown fields are refused, as in a plan. */
export function validatePolicy(input: unknown): Policy {
  ensure(isRecord(input), 'The policy must be a JSON object')
  const policy = input as Record<string, unknown>
  const unknown = Object.keys(policy).find((key) => !KEYS.includes(key))
  ensure(!unknown, `Unsupported policy field: ${unknown}`)
  ensure(policy.schema === POLICY_SCHEMA, `schema must be ${POLICY_SCHEMA}`)
  const {
    runs = 3,
    ignore = [],
    apps = {},
    env = [],
    testFiles = DEFAULT_TEST_FILES,
  } = policy
  ensure(isIntegerIn(runs, 1, 10), 'runs must be a whole number from 1 to 10')
  ensure(isRecord(apps), 'apps must map names to apps')
  const result: Policy = {
    schema: POLICY_SCHEMA,
    runs: runs as number,
    setup: commands(policy.setup ?? [], 'setup'),
    projectChecks: listOf(policy.projectChecks, 'projectChecks', projectCheck),
    claims: listOf(policy.claims, 'claims', claim),
    apps: Object.fromEntries(
      Object.entries(apps as object).map(([name, value]) => [
        name,
        app(value, `apps.${name}`),
      ]),
    ),
    budgets: budgets(policy.budgets),
    ignore: patterns(ignore, 'ignore'),
    env: names(env, 'env', /^[A-Za-z_][A-Za-z0-9_]*$/),
    testFiles: patterns(testFiles, 'testFiles'),
  }
  ensure(
    result.claims.length + result.projectChecks.length > 0,
    'The policy needs at least one claim or project check',
  )
  const strange = result.claims.find((c) => c.app && !result.apps[c.app])
  ensure(
    !strange,
    `claim ${strange?.id} names an app the policy doesn't define`,
  )
  return result
}
