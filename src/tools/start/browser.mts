import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Browser } from 'playwright'
import type { StartIo } from '../ask.mjs'
import type { StartOptions } from './args.mjs'

const require = createRequire(import.meta.url)

function installChromium() {
  const cli = join(
    dirname(require.resolve('playwright/package.json')),
    'cli.js',
  )
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: 'inherit',
      shell: false,
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              'Chromium installation failed. Run npx playwright install chromium, then retry.',
            ),
          ),
    )
  })
}

/** Launches Chromium for a web setup, downloading it on the first run. */
export async function launchWeb(
  options: StartOptions,
  io: StartIo,
): Promise<Browser> {
  let playwright: typeof import('playwright')
  try {
    playwright = await import('playwright')
  } catch {
    throw new Error(
      'Install the browser adapter: npm install --save-dev playwright@1.62.1',
    )
  }
  // Install the browser automatically only if it is missing, never for other launch errors.
  try {
    await access(playwright.chromium.executablePath())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    io.log('Downloading Chromium for the first run…')
    await installChromium()
  }
  return playwright.chromium.launch({ headless: Boolean(options.headless) })
}
