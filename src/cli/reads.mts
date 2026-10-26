import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  connectDesktop,
  desktopPages,
  selectDesktopPage,
} from '../targets/cdp.mjs'
import { reportFolder } from '../reports/folder.mjs'
import { discoverDesktop, type DesktopDiscovery } from '../workflows/reads.mjs'
import { discoverWeb } from '../workflows/web.mjs'
import { integerOption, text, UsageError, type Values } from './args.mjs'

export const usage = `recovery-probe reads --url URL [--state FILE] [options]
recovery-probe reads [--cdp URL] [--page N] [options]

Reloads the page and lists the GET fetch/XHR JSON reads it makes, then writes a
scenario.json to fill in for recovery-probe check. With --url it opens Chromium;
otherwise it attaches to the app or browser on the debugging port.

Options:
  --url URL        open this page in Chromium
  --state FILE     login state from recovery-probe login
  --headed         show the browser it opens
  --cdp URL        the debugging port to attach to (default http://127.0.0.1:9222)
  --page N         the window to use, from recovery-probe windows
  --duration MS    how long to watch after the reload, 200–30000 (default 5000)
  --out DIR        a new folder for discovery.json and scenario.json
  --json           print the reads as JSON

Finding no reads isn't a pass: the screen may load over IPC, from a cache or a
service worker, or after the window. See docs/desktop.md.`

export const options = {
  url: { type: 'string' },
  state: { type: 'string' },
  headed: { type: 'boolean' },
  cdp: { type: 'string' },
  page: { type: 'string' },
  duration: { type: 'string' },
  out: { type: 'string' },
  json: { type: 'boolean' },
} as const

export async function run(values: Values): Promise<void> {
  const url = text(values, 'url')
  if (url && (values.cdp !== undefined || values.page !== undefined))
    throw new UsageError(
      'Use --url to open a page, or --cdp and --page to attach, not both',
    )
  if ((values.state !== undefined || values.headed) && !url)
    throw new UsageError(
      '--state and --headed are only for a page opened with --url',
    )
  const durationMs = integerOption(values, 'duration', [200, 30000]) ?? 5000
  // The old desktop spelling may write into an existing folder.
  const directory = await reportFolder('reads', text(values, 'out'), {
    reuse: values.reuseOut === true,
  })
  const { discovery, scenario } = url
    ? await readsInBrowser(url, values, durationMs)
    : await readsOverCdp(values, durationMs)
  await writeReads(directory, discovery, scenario)
  if (values.json) console.log(JSON.stringify(discovery, null, 2))
  else printReads(discovery, directory)
}

interface Reads {
  discovery: DesktopDiscovery
  /** The scenario fields that depend on how the page was reached. */
  scenario: Record<string, unknown>
}

async function readsInBrowser(
  url: string,
  values: Values,
  durationMs: number,
): Promise<Reads> {
  const state = text(values, 'state')
  const session = {
    pageUrl: url,
    ...(state ? { storageState: resolve(state) } : {}),
  }
  const discovery = await discoverWeb(
    { ...session, headless: !values.headed },
    { durationMs },
  )
  return { discovery, scenario: { ...session, recovery: 'automatic' } }
}

async function readsOverCdp(
  values: Values,
  durationMs: number,
): Promise<Reads> {
  const cdp = text(values, 'cdp') ?? 'http://127.0.0.1:9222'
  const page = integerOption(values, 'page', [0, 1000])
  // Closing a CDP connection disconnects this client; it doesn't close the app.
  const browser = await connectDesktop(cdp)
  try {
    const target = selectDesktopPage(browser, { page })
    const discovery = await discoverDesktop(target, { durationMs })
    const scenario = {
      cdp,
      page: desktopPages(browser).indexOf(target),
      recovery: 'retry',
      retrySelector: '',
    }
    return { discovery, scenario }
  } finally {
    await browser.close()
  }
}

async function writeReads(
  directory: string,
  discovery: DesktopDiscovery,
  scenario: Record<string, unknown>,
) {
  const write = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
    })
  const [only] = discovery.endpoints
  await write('discovery.json', discovery)
  await write('scenario.json', {
    ...scenario,
    pageUrl: discovery.pageUrl,
    endpoint: discovery.endpoints.length === 1 ? only.endpoint : '',
    readySelector: '',
    timeoutMs: 5000,
  })
}

function printReads(discovery: DesktopDiscovery, directory: string) {
  discovery.endpoints.forEach((row, index) =>
    console.log(
      `${index + 1}. GET ${row.endpoint} (${row.observed} response(s), query values omitted)`,
    ),
  )
  if (!discovery.endpoints.length)
    console.log(
      'No GET JSON reads seen. The screen may load over IPC, from a cache or a service worker, or after the window. This is not a pass.',
    )
  console.log(
    `\nReads: ${join(directory, 'discovery.json')}\nFill in the endpoint (if blank) and readySelector in ${join(directory, 'scenario.json')}, then run recovery-probe check --config with it.`,
  )
}
