import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../../src/', import.meta.url))
// Each layer may import itself and the layers listed for it, never upward.
const allowed = {
  core: [],
  transports: ['core'],
  targets: ['core', 'transports'],
  reports: ['core'],
  workflows: ['core', 'transports', 'targets', 'reports'],
  tools: ['core', 'transports', 'targets', 'reports', 'workflows'],
  cli: ['core', 'transports', 'targets', 'reports', 'workflows', 'tools'],
}
const layerOf = (file) => {
  const [first, ...rest] = file.split('/')
  return rest.length ? first : 'public'
}

const sources = readdirSync(src, { recursive: true })
  .map((file) => file.split(sep).join('/'))
  .filter((file) => /\.[cm]ts$/.test(file))

// Runtime imports only: a type import doesn't load the module.
function runtimeImports(file) {
  const text = readFileSync(join(src, file), 'utf8')
  const found = []
  for (const [statement, names, specifier] of text.matchAll(
    /^(?:import|export)\s+(?!type\b)([^'"]*?)\s*from\s*'(\.[^']+)'/gm,
  )) {
    const values = /^\{([^}]*)\}$/.test(names.trim())
      ? names
          .trim()
          .slice(1, -1)
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n && !n.startsWith('type '))
      : [names]
    if (values.length || !statement.startsWith('import')) found.push(specifier)
  }
  for (const [, specifier] of text.matchAll(/import\('(\.[^']+)'\)/g))
    found.push(specifier)
  return found.map((specifier) =>
    relative(src, join(dirname(join(src, file)), specifier))
      .split(sep)
      .join('/')
      .replace(/\.mjs$/, '.mts')
      .replace(/\.cjs$/, '.cts'),
  )
}

test('modules import only their own layer and the layers below it', () => {
  const wrong = []
  for (const file of sources) {
    const from = layerOf(file)
    for (const target of runtimeImports(file)) {
      const to = layerOf(target)
      const ok =
        from === 'public'
          ? to !== 'public' && to !== 'cli'
          : to === from || allowed[from].includes(to)
      if (!ok) wrong.push(`${file} -> ${target}`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('the public entry points only re-export', () => {
  for (const file of sources.filter((f) => layerOf(f) === 'public')) {
    if (file === 'ipc-probe.cts') continue // The hook an app loads by path; it stands alone.
    const code = readFileSync(join(src, file), 'utf8')
      .replace(/^\s*export (type )?\{[^}]*\} from '[^']+'\s*$/gm, '')
      .trim()
    assert.equal(code, '', file)
  }
})
