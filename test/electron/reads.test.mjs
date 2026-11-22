import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachWindow, launchElectron } from '../helpers/electron.mjs'
import { connectIpcInspector } from '../../dist/ipc-inspector.mjs'

const exec = promisify(execFile)

test(
  'reads --inspector lists the IPC calls a real Electron window makes while it loads, and leaves the hook clean',
  { timeout: 120000 },
  async () => {
    const electron = await launchElectron(
      fileURLToPath(
        new URL('../fixtures/ipc-electron/main.cjs', import.meta.url),
      ),
      { inspect: true },
    )
    const { cdp, inspector } = electron
    const dir = await mkdtemp(join(tmpdir(), 'ipc-reads-'))
    let browser
    let control
    try {
      let page
      ;({ browser, page } = await attachWindow(cdp, 'ipc-electron/index.html'))
      await page.locator('#row').waitFor()
      const out = join(dir, 'reads')
      const { stdout } = await exec(process.execPath, [
        fileURLToPath(new URL('../../bin/recovery-probe.mjs', import.meta.url)),
        'reads',
        '--inspector',
        inspector,
        '--cdp',
        cdp,
        '--duration',
        '1500',
        '--out',
        out,
        '--json',
      ])
      // The page reads its versions, then the file; it never writes while loading.
      const reads = JSON.parse(stdout)
      assert.deepEqual(
        reads.channels.map(({ channel, calls, errors }) => ({
          channel,
          calls,
          errors,
        })),
        [
          { channel: 'fixture:versions', calls: 1, errors: 0 },
          { channel: 'fixture:read', calls: 1, errors: 0 },
        ],
      )
      assert.match(reads.pageUrl, /ipc-electron\/index\.html$/)
      const scenario = JSON.parse(
        await readFile(join(out, 'scenario.json'), 'utf8'),
      )
      assert.deepEqual(scenario, {
        cdp,
        inspector,
        channel: '',
        requiredChannels: [],
      })
      control = await connectIpcInspector(inspector)
      const after = await control.call('snapshot')
      assert.equal(after.armed, null)
      assert.equal(after.observingUntil, null)
      await page.locator('#row').waitFor()
    } finally {
      control?.close()
      await browser?.close()
      await electron.stop()
      await rm(dir, { recursive: true, force: true })
    }
  },
)
