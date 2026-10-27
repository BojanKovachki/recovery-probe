import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { scanSource } from '../../dist/tools/suspects/source.mjs'
import {
  sourceFiles,
  changedSourceFiles,
} from '../../dist/tools/suspects/files.mjs'

const scan = (code, file = 'store.ts') =>
  scanSource(ts, file, code).map(({ pattern, line, read }) => ({
    pattern,
    line,
    ...(read ? { read } : {}),
  }))

test('finds a failed read turned into an empty collection', () => {
  assert.deepEqual(
    scan(`async function update(item) {
  const files = (await listInstalledFiles(item)) ?? []
  return reconcile(files)
}`),
    [
      {
        pattern: 'UNKNOWN_AS_EMPTY',
        line: 2,
        read: 'listInstalledFiles(item)',
      },
    ],
  )
  assert.deepEqual(scan(`const rows = load().catch(() => [])`), [
    { pattern: 'UNKNOWN_AS_EMPTY', line: 1, read: 'load()' },
  ])
  assert.deepEqual(
    scan(`async function rows() {
  try {
    return await load()
  } catch {
    return []
  }
}`),
    [{ pattern: 'UNKNOWN_AS_EMPTY', line: 5, read: 'load()' }],
  )
})

test('finds an empty collection stored on a failure path', () => {
  // As in a store that treats an unexpected answer as "no rooms".
  assert.deepEqual(
    scan(`api.getAll().then((r) => {
  if (Array.isArray(r)) {
    setSelf({ data: r })
  } else {
    setSelf({ data: [], isLoading: false })
  }
})`),
    [{ pattern: 'UNKNOWN_AS_EMPTY', line: 5, read: 'api.getAll()' }],
  )
  assert.deepEqual(
    scan(`async function refresh() {
  try {
    setItems(await load())
  } catch (error) {
    setState({ items: [] })
  }
}`),
    [{ pattern: 'UNKNOWN_AS_EMPTY', line: 5, read: 'load()' }],
  )
})

test('finds a read whose failure is only logged', () => {
  assert.deepEqual(
    scan(`fetchFriends()
  .then((friends) => setSelf((state) => merge(state, friends)))
  .catch(logFetchError)`),
    [{ pattern: 'FAILURE_ONLY_LOGGED', line: 3, read: 'fetchFriends()' }],
  )
  assert.deepEqual(
    scan(`async function load() {
  try {
    const rows = await fetchRows()
    setRows(rows)
  } catch (error) {
    console.error(error)
  }
}`),
    [{ pattern: 'FAILURE_ONLY_LOGGED', line: 5, read: 'fetchRows()' }],
  )
})

test('leaves code that keeps "unknown" apart or handles the failure', () => {
  for (const code of [
    // A real default, or keeping "unknown" as undefined, is not "empty".
    `const name = (await load()) ?? 'Unknown'`,
    `const rows = load().catch(() => undefined)`,
    // An action that only toggles a flag stores nothing it read.
    `save().then(() => setSaving(false)).catch(logError)`,
    `async function send() {
  try {
    await save()
    setSaved(true)
  } catch (error) {
    log(error)
  }
}`,
    // The failure is handled, not only logged.
    `load().then((rows) => setRows(rows)).catch((error) => { log(error); setError(error) })`,
    // Timers are not state.
    `try { await load() } catch { setTimeout(() => {}, 0) }`,
  ])
    assert.deepEqual(scan(code), [], code)
})

test('skips a line marked as reviewed', () => {
  assert.deepEqual(
    scan(`// recovery-probe-ignore: an empty cache is a cache miss
const cache = (await readCache()) ?? {}`),
    [],
  )
})

test('reads TSX', () => {
  assert.deepEqual(
    scan(
      `const View = () => <List rows={rows} />
const rows = (await load()) ?? []`,
      'View.tsx',
    ).map((s) => s.pattern),
    ['UNKNOWN_AS_EMPTY'],
  )
})

test('lists source files, leaving dependencies, build output, tests and declarations out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-suspects-'))
  try {
    for (const path of [
      'src/store.ts',
      'src/view.tsx',
      'src/store.test.ts',
      'src/types.d.ts',
      'src/__tests__/helper.ts',
      'node_modules/lib/index.js',
      'dist/store.js',
      'README.md',
    ]) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), '')
    }
    const names = (files) =>
      files.map((file) => file.slice(root.length + 1).replaceAll('\\', '/'))
    assert.deepEqual(names(await sourceFiles([root])).sort(), [
      'src/store.ts',
      'src/view.tsx',
    ])
    assert.deepEqual(
      names(await sourceFiles([root], { includeTests: true })).sort(),
      [
        'src/__tests__/helper.ts',
        'src/store.test.ts',
        'src/store.ts',
        'src/view.tsx',
      ],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lists the source files a branch changed, uncommitted and untracked ones included', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-changed-'))
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/old.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'src/same.ts'), 'export const b = 1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'start')
    await writeFile(join(root, 'src/old.ts'), 'export const a = 2\n')
    await writeFile(join(root, 'src/new.ts'), 'export const c = 1\n')
    const changed = await changedSourceFiles('main', { cwd: join(root, 'src') })
    assert.deepEqual(
      changed
        .map((file) => file.replaceAll('\\', '/').split('/').at(-1))
        .sort(),
      ['new.ts', 'old.ts'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
