import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/** A registry path as a safe relative path with forward slashes, or undefined when it is not one. */
export function safeRelativePath(value: string): string | undefined {
  const path = value.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = path.split('/')
  if (
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    parts.some((part) => part === '' || part === '..')
  )
    return undefined
  return path
}

/** Why `path` is not a file or folder inside `root`, following symlinks; undefined when it is. */
export async function outsideProblem(root: string, path: string) {
  const safe = safeRelativePath(path)
  if (!safe) return `${path} is not a relative path inside the project`
  const target = join(root, safe)
  if (!existsSync(target)) return `${path} does not exist`
  const inside = relative(await realpath(root), await realpath(target))
  if (!inside || inside.startsWith('..') || isAbsolute(inside))
    return `${path} leads outside the project`
  return undefined
}
