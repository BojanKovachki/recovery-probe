import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const pages = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...readdirSync(join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
]

// GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens.
const anchors = (markdown) =>
  new Set(
    [
      ...markdown.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6} (.+)$/gm),
    ].map(([, heading]) =>
      heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\- ]/gu, '')
        .replace(/ /g, '-'),
    ),
  )

test('every relative link in the docs points to a file and heading that exist', () => {
  const broken = []
  for (const page of pages) {
    const markdown = readFileSync(join(root, page), 'utf8')
    for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue
      const [path, anchor] = target.split('#')
      const file = path
        ? join(dirname(join(root, page)), path)
        : join(root, page)
      if (!existsSync(file)) broken.push(`${page}: ${target}`)
      else if (
        anchor &&
        file.endsWith('.md') &&
        !anchors(readFileSync(file, 'utf8')).has(anchor)
      )
        broken.push(
          `${page}: ${target} (no heading ${relative(root, file)}#${anchor})`,
        )
    }
  }
  assert.deepEqual(broken, [])
})

test('docs name versions only in the changelog', () => {
  for (const page of pages)
    assert.doesNotMatch(
      readFileSync(join(root, page), 'utf8'),
      /\((?:\d+\.\d+\.\d+-)?preview\.\d+\)|available since|recovery-probe@\d/i,
      page,
    )
})
