import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { openWeb } from '../targets/browser.mjs'
import { text, UsageError, type Values } from './args.mjs'

export const usage = `recovery-probe login --url URL --state FILE

Opens Chromium at URL. Sign in, then press Enter in the terminal, and the login
state (cookies, local storage, IndexedDB) is saved to FILE for --state. The file
holds credentials: keep it private and out of Git. Session-storage-only logins
can't be saved this way.`

export const options = {
  url: { type: 'string' },
  state: { type: 'string' },
} as const

export async function run(values: Values): Promise<void> {
  const url = text(values, 'url')
  const statePath = text(values, 'state')
  if (!url || !statePath) throw new UsageError('--url and --state are required')
  if (!process.stdin.isTTY)
    throw new UsageError('login needs an interactive terminal')
  const state = resolve(statePath)
  await mkdir(dirname(state), { recursive: true, mode: 0o700 })
  const session = await openWeb({ pageUrl: url, headless: false })
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    await terminal.question(
      'Sign in using the browser, return to your app, then press Enter to save login state. ',
    )
    const saved = await session.context.storageState({ indexedDB: true })
    await writeFile(state, JSON.stringify(saved), { mode: 0o600, flag: 'wx' })
    console.log(`Saved ${state}. Keep it private.`)
  } finally {
    terminal.close()
    await session.browser.close()
  }
}
