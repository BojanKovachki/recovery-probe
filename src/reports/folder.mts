import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * A new private folder for one run's report: `out`, which must not exist yet,
 * or a new `.recovery-probe/<prefix>-…` folder. Git ignores everything in it.
 */
export async function reportFolder(
  prefix: string,
  out?: string,
): Promise<string> {
  let directory: string
  if (out) {
    directory = resolve(out)
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
    await mkdir(directory, { mode: 0o700 })
  } else {
    const parent = resolve('.recovery-probe')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    directory = await mkdtemp(join(parent, `${prefix}-`))
  }
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  return directory
}

/** Writes next to `file`, then renames over it, so a reader never sees half a file. */
export async function writeAtomically(file: string, content: string) {
  await writeFile(`${file}.tmp`, content, { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}
