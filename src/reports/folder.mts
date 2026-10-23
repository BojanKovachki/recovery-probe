import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * A new private folder for one run's report: `out`, which must not exist yet
 * unless `reuse` is set, or a new `.recovery-probe/<prefix>-…` folder. Git
 * ignores everything in it.
 */
export async function reportFolder(
  prefix: string,
  out?: string,
  { reuse = false } = {},
): Promise<string> {
  let directory: string
  if (out) {
    directory = resolve(out)
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
    await mkdir(directory, { recursive: reuse, mode: 0o700 })
  } else {
    const parent = resolve('.recovery-probe')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    directory = await mkdtemp(join(parent, `${prefix}-`))
  }
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  return directory
}
