import type { ChangedFile } from '../plan/changes.mjs'
import { safeRelativePath } from '../plan/paths.mjs'
import { globRegExp, selections } from '../plan/select.mjs'
import { matchingVersion, type Registries, type Sides } from './criteria.mjs'
import type { Policy } from './policy.mjs'
import type { ReviewSignal } from './types.mjs'

/** What the candidate did to the files the base's policy names as tests. */
export interface TestChanges {
  /** Test files the candidate changed or deleted: criteria a person must approve. */
  changed: string[]
  /** Every deleted, changed and added test file, by code; added ones are only for review. */
  signals: ReviewSignal[]
  /** Each side's test files, hashed by path and committed content; null when it has none. */
  versions: Record<'base' | 'candidate', string | null>
}

const CODES: Record<ChangedFile['status'], ReviewSignal['code']> = {
  deleted: 'TEST_FILE_DELETED',
  modified: 'TEST_FILE_CHANGED',
  added: 'TEST_FILE_ADDED',
  untracked: 'TEST_FILE_ADDED',
  // A renamed test is deleted at its old path; its new path counts as added.
  renamed: 'TEST_FILE_ADDED',
}
const ORDER: ReviewSignal['code'][] = [
  'TEST_FILE_DELETED',
  'TEST_FILE_CHANGED',
  'TEST_FILE_ADDED',
]

/** The changed files that match the base's `testFiles` patterns, and each side's test files' hash. */
export async function testChanges(
  sides: Sides,
  changes: ChangedFile[],
  patterns: string[],
): Promise<TestChanges> {
  const rules = patterns.map(globRegExp)
  const isTest = (path: string) => rules.some((rule) => rule.test(path))
  const found = new Map<ReviewSignal['code'], string[]>()
  const add = (code: ReviewSignal['code'], path: string) =>
    found.set(code, [...(found.get(code) ?? []), path])
  for (const change of changes) {
    if (change.previousPath && isTest(change.previousPath))
      add('TEST_FILE_DELETED', change.previousPath)
    if (isTest(change.path)) add(CODES[change.status], change.path)
  }
  const signals = ORDER.filter((code) => found.has(code)).map((code) => ({
    code,
    paths: found.get(code)!.sort(),
  }))
  return {
    changed: signals
      .filter((signal) => signal.code !== 'TEST_FILE_ADDED')
      .flatMap((signal) => signal.paths)
      .sort(),
    signals,
    versions: {
      base: await matchingVersion(sides.root, sides.base, rules),
      candidate: await matchingVersion(sides.root, sides.candidate, rules),
    },
  }
}

/** Changed files the base's ignore rules leave out, and those no claim's scenarios cover. */
export function coverageOf(
  policy: Policy,
  registries: Registries,
  changes: ChangedFile[],
) {
  const rules = policy.ignore.map(globRegExp)
  const ignored = changes.filter((change) =>
    rules.some((rule) => rule.test(change.path)),
  )
  const rest = changes.filter((change) => !ignored.includes(change))
  const entries = policy.claims
    .flatMap((claim) => [claim.failurePath, claim.normalPath])
    .map((name) => {
      const paths = registries.base.get(name)?.paths
      return {
        name,
        paths: (Array.isArray(paths) ? paths : []).filter(
          (path): path is string =>
            typeof path === 'string' && Boolean(safeRelativePath(path)),
        ),
      }
    })
  const covered = new Set(selections(rest, entries).map((found) => found.file))
  return {
    uncovered: rest
      .map((change) => change.path)
      .filter((path) => !covered.has(path)),
    ignored: ignored.map((change) => change.path),
  }
}
