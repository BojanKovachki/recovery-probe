import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  connectDesktop,
  desktopPages,
  selectDesktopPage,
} from '../targets/cdp.mjs'
import { attachIpcWindow } from '../targets/ipc-window.mjs'
import { connectIpcInspector } from '../transports/ipc/inspector.mjs'
import { reportFolder } from '../reports/folder.mjs'
import {
  discoverDesktop,
  discoverIpcReads,
  type DesktopDiscovery,
  type IpcReads,
} from '../workflows/reads.mjs'
import { discoverWeb } from '../workflows/web.mjs'
import { integerOption, text, UsageError, type Values } from './args.mjs'

export const usage = `recovery-probe reads --url URL [--state FILE] [options]
recovery-probe reads [--cdp URL] [--page N] [options]
recovery-probe reads --inspector URL [--cdp URL] [options]

Reloads the page and lists the GET fetch/XHR JSON reads it makes, then writes a
scenario.json to fill in for recovery-probe check. With --url it opens Chromium;
otherwise it attaches to the app or browser on the debugging port. With
--inspector it lists the IPC calls the window of an Electron app with the hook
makes instead, and the scenario.json is for recovery-probe discover.

Options:
  --url URL        open this page in Chromium
  --state FILE     login state from recovery-probe login
  --headed         show the browser it opens
  --cdp URL        the debugging port to attach to (default http://127.0.0.1:9222)
  --page N         the window to use, from recovery-probe windows
  --inspector URL  the Node inspector of an Electron app with the IPC hook
  --duration MS    how long to watch after the reload, 200–30000 (default 5000)
  --out DIR        a new folder for discovery.json and scenario.json
  --json           print the reads as JSON

Finding no reads isn't a pass: the screen may load over IPC (use --inspector),
from a cache or a service worker, or after the window. See docs/desktop.md and
docs/ipc.md.`

export const options = {
  url: { type: 'string' },
  state: { type: 'string' },
  headed: { type: 'boolean' },
  cdp: { type: 'string' },
  page: { type: 'string' },
  inspector: { type: 'string' },
  duration: { type: 'string' },
  out: { type: 'string' },
  json: { type: 'boolean' },
} as const

export async function run(values: Values): Promise<void> {
  checkCombination(values)
  const url = text(values, 'url')
  const durationMs = integerOption(values, 'duration', [200, 30000]) ?? 5000
  const directory = await reportFolder('reads', text(values, 'out'))
  const reads = text(values, 'inspector')
    ? await readsOverIpc(values, durationMs)
    : url
      ? await readsInBrowser(url, values, durationMs)
      : await readsOverCdp(values, durationMs)
  await writeReads(directory, reads)
  if (values.json) console.log(JSON.stringify(reads.discovery, null, 2))
  else reads.print(directory)
}

function checkCombination(values: Values) {
  const url = text(values, 'url')
  if (url && (values.cdp !== undefined || values.page !== undefined))
    throw new UsageError(
      'Use --url to open a page, or --cdp and --page to attach, not both',
    )
  if ((values.state !== undefined || values.headed) && !url)
    throw new UsageError(
      '--state and --headed are only for a page opened with --url',
    )
  if (values.inspector !== undefined && (url || values.page !== undefined))
    throw new UsageError(
      '--inspector attaches to the window the IPC hook watches; leave out --url and --page',
    )
}

interface Reads {
  discovery: DesktopDiscovery | IpcReads
  /** The configuration to fill in for the next command. */
  scenario: Record<string, unknown>
  print(directory: string): void
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
  return httpReads(discovery, { ...session, recovery: 'automatic' })
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
    return httpReads(discovery, {
      cdp,
      page: desktopPages(browser).indexOf(target),
      recovery: 'retry',
      retrySelector: '',
    })
  } finally {
    await browser.close()
  }
}

async function readsOverIpc(
  values: Values,
  durationMs: number,
): Promise<Reads> {
  const cdp = text(values, 'cdp') ?? 'http://127.0.0.1:9222'
  const inspector = text(values, 'inspector')!
  const control = await connectIpcInspector(inspector)
  try {
    const browser = await connectDesktop(cdp)
    try {
      const { page, identity } = await attachIpcWindow(browser, control, [])
      const discovery = await discoverIpcReads(page, control, identity, {
        durationMs,
      })
      const [only] = discovery.channels
      return {
        discovery,
        scenario: {
          cdp,
          inspector,
          channel: discovery.channels.length === 1 ? only.channel : '',
          requiredChannels: [],
        },
        print: (directory) => printIpcReads(discovery, directory),
      }
    } finally {
      await browser.close()
    }
  } finally {
    control.close()
  }
}

/** HTTP reads with a check scenario that names the endpoint when there was only one. */
function httpReads(
  discovery: DesktopDiscovery,
  session: Record<string, unknown>,
): Reads {
  const [only] = discovery.endpoints
  return {
    discovery,
    scenario: {
      ...session,
      pageUrl: discovery.pageUrl,
      endpoint: discovery.endpoints.length === 1 ? only.endpoint : '',
      readySelector: '',
      timeoutMs: 5000,
    },
    print: (directory) => printReads(discovery, directory),
  }
}

async function writeReads(directory: string, reads: Reads) {
  const write = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
    })
  await write('discovery.json', reads.discovery)
  await write('scenario.json', reads.scenario)
}

function printReads(discovery: DesktopDiscovery, directory: string) {
  discovery.endpoints.forEach((row, index) =>
    console.log(
      `${index + 1}. GET ${row.endpoint} (${row.observed} response(s), query values omitted)`,
    ),
  )
  if (!discovery.endpoints.length)
    console.log(
      'No GET JSON reads seen. The screen may load over IPC (list those with --inspector), from a cache or a service worker, or after the window. This is not a pass.',
    )
  console.log(
    `\nReads: ${join(directory, 'discovery.json')}\nFill in the endpoint (if blank) and readySelector in ${join(directory, 'scenario.json')}, then run recovery-probe check --config with it.`,
  )
}

function printIpcReads(discovery: IpcReads, directory: string) {
  discovery.channels.forEach((row, index) => {
    const failed = row.errors ? `, ${row.errors} failed` : ''
    console.log(`${index + 1}. ${row.channel} (${row.calls} call(s)${failed})`)
    for (const [label, calls] of Object.entries(row.methods ?? {}))
      console.log(`     ${label}: ${calls}`)
  })
  if (!discovery.channels.length)
    console.log(
      "No IPC calls seen on the channels the hook captured. The screen may load from a cache, over a channel the hook wasn't given, or after the window. This is not a pass.",
    )
  console.log(
    `\nReads: ${join(directory, 'discovery.json')}\nFill in the channel (if blank) and the other reads the screen needs (requiredChannels) in ${join(directory, 'scenario.json')}, then run recovery-probe discover --config with it.`,
  )
}
