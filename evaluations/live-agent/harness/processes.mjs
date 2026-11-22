// The processes an attempt's agent session starts: servers, browsers and shells it leaves
// running. On Windows a child outlives its parent, so they are recorded while the session runs
// and ended afterwards, matched by id and creation time so that a reused id is never ended.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { killTree } from './agent.mjs'

const TABLE =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }'

/** Every process as { pid, parent, created } (Windows). */
async function processTable() {
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', TABLE],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  )
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [pid, parent, created] = line.trim().split(' ')
      return { pid: Number(pid), parent: Number(parent), created }
    })
}

/** The processes descended from `root` in `table`, its exited processes' orphans included. */
export function descendantsOf(root, table) {
  const children = new Map()
  for (const process of table) {
    if (!children.has(process.parent)) children.set(process.parent, [])
    children.get(process.parent).push(process)
  }
  const found = []
  const seen = new Set([root])
  const queue = [root]
  while (queue.length)
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      queue.push(child.pid)
    }
  return found
}

/** Records the session's processes every few seconds; `end` ends those still running. */
export function trackSession(intervalMs = 5000) {
  const started = new Map()
  let root
  let timer
  const record = async () => {
    if (!root || process.platform !== 'win32') return
    try {
      for (const child of descendantsOf(root, await processTable()))
        started.set(child.pid, child.created)
    } catch {}
  }
  return {
    start(pid) {
      root = pid
      timer = setInterval(record, intervalMs)
    },
    async end() {
      clearInterval(timer)
      if (!root) return
      if (process.platform !== 'win32') return killTree(root)
      await record()
      for (const { pid, created } of await processTable())
        if (started.get(pid) === created) killTree(pid)
    },
  }
}
