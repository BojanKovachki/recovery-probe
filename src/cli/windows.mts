import { pageIdentity } from '../core/urls.mjs'
import { connectDesktop, desktopPages } from '../targets/cdp.mjs'
import { text, type Values } from './args.mjs'

export const usage = `recovery-probe windows [--cdp URL] [--json]

Lists the windows of the app or browser on the debugging port, with the index
that --page takes. Query strings and fragments are left out.

Options:
  --cdp URL   the debugging port (default http://127.0.0.1:9222)
  --json      print the windows as JSON`

export const options = {
  cdp: { type: 'string' },
  json: { type: 'boolean' },
} as const

export async function run(values: Values): Promise<void> {
  // Closing a CDP connection disconnects this client; it doesn't close the app.
  const browser = await connectDesktop(
    text(values, 'cdp') ?? 'http://127.0.0.1:9222',
  )
  try {
    const windows = desktopPages(browser).map((page, index) => ({
      index,
      url: pageIdentity(page.url()),
    }))
    if (values.json) console.log(JSON.stringify(windows, null, 2))
    else if (!windows.length) throw new Error('No windows found')
    else for (const w of windows) console.log(`${w.index}  ${w.url}`)
  } finally {
    await browser.close()
  }
}
