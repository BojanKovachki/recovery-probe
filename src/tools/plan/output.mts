import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { PlanInputError } from './changes.mjs'
import { safeRelativePath } from './paths.mjs'

/**
 * `path` as a relative path inside the working directory none of whose existing components is
 * a symbolic link, dangling ones included. Checked before anything is created, so creating a
 * folder cannot follow a link out either. `what` names the output in errors, such as "plan".
 */
export async function safeOutputPath(path: string, what: string) {
  const safe = safeRelativePath(path)
  if (!safe)
    throw new PlanInputError(
      `Write the ${what} inside the working directory, with a relative path: ${path}`,
    )
  let current = process.cwd()
  for (const component of safe.split('/')) {
    current = join(current, component)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (info?.isSymbolicLink())
      throw new PlanInputError(
        `${what[0].toUpperCase()}${what.slice(1)} output must not traverse a symbolic link: ${path}`,
      )
  }
  return safe
}
