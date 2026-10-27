import { statSync, watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { SKIPPED_DIRECTORIES } from '../suspects/files.mjs'

export interface SourceWatcher {
  close(): void
}

// Editor swap, backup and lock files change without the source changing.
const EDITOR_FILE =
  /(?:~|\.swp|\.swx|\.tmp)$|(?:^|[\\/])(?:\.#|#)[^\\/]*$|(?:^|[\\/])4913$/

const isIgnored = (path: string) =>
  path.split(/[\\/]/).some((part) => SKIPPED_DIRECTORIES.has(part)) ||
  EDITOR_FILE.test(path)

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Collects changed files and hands them on once they have been quiet for a while. */
class SourceChanges {
  readonly #onChange: (files: string[]) => void
  readonly #settleMs: number
  readonly #ignored: string[]
  readonly #watchers = new Map<string, FSWatcher>()
  readonly #pending = new Set<string>()
  #timer: NodeJS.Timeout | undefined
  #closed = false

  constructor(
    onChange: (files: string[]) => void,
    settleMs: number,
    ignored: string[],
  ) {
    this.#onChange = onChange
    this.#settleMs = settleMs
    this.#ignored = ignored
  }

  async watch(path: string, recursive: boolean) {
    if (!isDirectory(path))
      this.#add(
        path,
        watch(path, () => this.#changed(path, resolve(path, '..'))),
      )
    else if (!recursive) await this.#watchTree(path, path, false)
    else
      this.#add(
        path,
        watch(path, { recursive: true }, (_event, name) => {
          if (name) this.#changed(join(path, name.toString()), path)
        }),
      )
  }

  close() {
    this.#closed = true
    clearTimeout(this.#timer)
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
  }

  #flush() {
    // A folder's own event only says something inside it changed.
    const files = [...this.#pending].filter((file) => !isDirectory(file)).sort()
    this.#pending.clear()
    if (files.length && !this.#closed) this.#onChange(files)
  }

  #changed(file: string, root: string) {
    const path = resolve(file)
    if (
      isIgnored(relative(root, path)) ||
      this.#ignored.some(
        (folder) => path === folder || path.startsWith(folder + sep),
      )
    )
      return
    this.#pending.add(path)
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#flush(), this.#settleMs)
  }

  #add(path: string, watcher: FSWatcher) {
    // A watched folder that is deleted reports an error; stop watching it.
    watcher.on('error', () => {
      watcher.close()
      this.#watchers.delete(path)
    })
    this.#watchers.set(path, watcher)
  }

  // Linux has no native recursive watch, and Node's emulation also watches
  // node_modules; so watch each folder there and add new ones as they appear.
  async #watchTree(folder: string, root: string, report: boolean) {
    if (this.#watchers.has(folder) || this.#closed) return
    this.#add(
      folder,
      watch(folder, (_event, name) => {
        if (!name) return
        const path = join(folder, name.toString())
        if (isIgnored(relative(root, path))) return
        if (isDirectory(path)) void this.#watchTree(path, root, true)
        this.#changed(path, root)
      }),
    )
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
        await this.#watchTree(path, root, report)
      // Files in a folder that appeared after the watch started.
      else if (report && entry.isFile()) this.#changed(path, root)
    }
  }
}

/**
 * Calls `onChange` with the files that changed under `paths`, once they have
 * been quiet for `settleMs`. Dependencies, build output, Recovery Probe's own
 * reports and the `ignore` folders are left out.
 */
export async function watchSources(
  paths: string[],
  onChange: (files: string[]) => void,
  {
    settleMs = 1500,
    ignore = [],
    // Linux has no native recursive watch; tests turn it off elsewhere too.
    recursive = process.platform !== 'linux',
  }: { settleMs?: number; ignore?: string[]; recursive?: boolean } = {},
): Promise<SourceWatcher> {
  const changes = new SourceChanges(
    onChange,
    settleMs,
    ignore.map((path) => resolve(path)),
  )
  for (const path of paths.map((p) => resolve(p)))
    await changes.watch(path, recursive)
  return { close: () => changes.close() }
}
