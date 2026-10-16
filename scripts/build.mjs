// Builds dist/: the compiler emits the TypeScript sources with their declarations, and
// the JavaScript not yet converted, hand-written declarations and report templates are
// copied unchanged.
import { cp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = fileURLToPath(new URL('../src', import.meta.url))
const dist = fileURLToPath(new URL('../dist', import.meta.url))
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')

await rm(dist, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
await cp(src, dist, {
  recursive: true,
  filter: (path) => !/\.[cm]?ts$/.test(path) || /\.d\.[cm]?ts$/.test(path),
})
