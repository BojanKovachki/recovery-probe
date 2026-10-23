import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { IpcIdentity } from './ipc-probe.cjs'
import { connectIpcInspector } from './ipc-inspector.mjs'

const require = createRequire(import.meta.url)

/** `missing` is something only some workflows need; `problem` blocks them. */
export type DoctorStatus = 'ok' | 'missing' | 'problem'

export interface DoctorCheck {
  name: string
  status: DoctorStatus
  detail: string
  fix?: string
}

export interface DoctorReport {
  version: string
  ok: boolean
  checks: DoctorCheck[]
  /** The hook in the running app, when one answered. */
  ipc?: IpcIdentity
}

export interface DoctorOptions {
  cdp?: string
  inspector?: string
}

/** Where the app loads the IPC hook from: this package's own copy. */
export const IPC_HOOK_PATH = fileURLToPath(
  new URL('./ipc-probe.cjs', import.meta.url),
)

export const CDP_FLAGS =
  '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222'

export function ipcHookSetup(hookPath = IPC_HOOK_PATH): string {
  return `In the Electron main process, before the IPC handlers are registered:

  if (!app.isPackaged && process.env.RECOVERY_PROBE_IPC === '1') {
    const { installIpcProbe } = require(process.env.RECOVERY_PROBE_IPC_MODULE)
    globalThis.__recoveryProbeIpc = installIpcProbe(ipcMain, {
      enabled: true,
      channels: ['your:read-channel'],
      sender: () => mainWindow?.webContents,
    })
  }

Start the app with RECOVERY_PROBE_IPC=1 and RECOVERY_PROBE_IPC_MODULE=${hookPath},
and pass --inspect=127.0.0.1:9229 ${CDP_FLAGS} to Electron. See docs/ipc.md.`
}

export async function packageVersion(): Promise<string> {
  return JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ).version
}

/** GETs a JSON document from a loopback debugging endpoint, or null when nothing answers. */
export async function probeJson(url: string): Promise<unknown> {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error(`${url} is not a loopback address`)
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/** The hook's identity, or why the inspector couldn't give one. */
export async function identifyIpcHook(
  inspector: string,
): Promise<{ identity: IpcIdentity } | { error: string }> {
  let control
  try {
    control = await connectIpcInspector(inspector)
  } catch (error) {
    return { error: (error as Error).message }
  }
  try {
    return { identity: await control.call('identify') }
  } catch (error) {
    return { error: (error as Error).message }
  } finally {
    control.close()
  }
}

function nodeCheck(): DoctorCheck {
  const major = Number(process.versions.node.split('.')[0])
  return major >= 22
    ? { name: 'Node.js', status: 'ok', detail: process.versions.node }
    : {
        name: 'Node.js',
        status: 'problem',
        detail: `${process.versions.node} is too old`,
        fix: 'Install Node.js 22 or newer.',
      }
}

async function playwrightChecks(): Promise<DoctorCheck[]> {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    return [
      {
        name: 'Playwright',
        status: 'problem',
        detail: 'not installed; browser and Electron checks need it',
        fix: 'npm install --save-dev playwright',
      },
    ]
  }
  const { version } = require('playwright/package.json')
  const browser: DoctorCheck = await access(chromium.executablePath()).then(
    () => ({ name: 'Chromium', status: 'ok', detail: 'installed' }),
    () => ({
      name: 'Chromium',
      status: 'missing',
      detail: 'not installed; only needed to launch a browser',
      fix: 'npx playwright install chromium',
    }),
  )
  return [{ name: 'Playwright', status: 'ok', detail: version }, browser]
}

async function cdpCheck(cdp: string): Promise<DoctorCheck> {
  const name = `App on ${cdp}`
  const info = (await probeJson(new URL('/json/version', cdp).href)) as {
    Browser?: string
    'User-Agent'?: string
  } | null
  if (!info)
    return {
      name,
      status: 'missing',
      detail:
        'nothing is listening; needed to test an Electron app or attach to a browser',
      fix: `Start Electron or Chromium with ${CDP_FLAGS}. The flags must reach Electron itself, not only its dev server.`,
    }
  const electron = /Electron\/([\d.]+)/.exec(info['User-Agent'] ?? '')?.[1]
  const pages = (
    ((await probeJson(new URL('/json/list', cdp).href)) as
      { type?: string }[] | null) ?? []
  ).filter((target) => target.type === 'page').length
  return {
    name,
    status: 'ok',
    detail: `${electron ? `Electron ${electron}` : (info.Browser ?? 'a browser')}, ${pages} ${pages === 1 ? 'window' : 'windows'}`,
  }
}

async function ipcCheck(
  inspector: string,
  version: string,
): Promise<{ check: DoctorCheck; identity?: IpcIdentity }> {
  const name = `IPC hook on ${inspector}`
  if (!(await probeJson(new URL('/json/list', inspector).href)))
    return {
      check: {
        name,
        status: 'missing',
        detail: 'no Node inspector; only needed for IPC checks',
        fix: `For IPC, load the hook from ${IPC_HOOK_PATH} and start Electron with --inspect=127.0.0.1:9229. See docs/ipc.md.`,
      },
    }
  const result = await identifyIpcHook(inspector)
  if ('error' in result) {
    const notLoaded = /__recoveryProbeIpc|undefined/.test(result.error)
    return {
      check: {
        name,
        status: 'problem',
        detail: notLoaded
          ? "the inspector is up, but the hook isn't loaded"
          : result.error,
        fix: notLoaded
          ? ipcHookSetup()
          : /WebContents/.test(result.error)
            ? "Open the app window. The hook's sender() must return its webContents."
            : undefined,
      },
    }
  }
  const { identity } = result
  if (identity.version !== version)
    return {
      identity,
      check: {
        name,
        status: 'problem',
        detail: `the app runs the hook from ${identity.version}; this CLI is ${version}`,
        fix: `Restart the app with RECOVERY_PROBE_IPC_MODULE=${IPC_HOOK_PATH}`,
      },
    }
  // The hook records a channel only if it's allowed and the app registers it after the hook loads.
  const unregistered = (identity.channels ?? []).filter(
    (c) => !identity.registered.includes(c),
  )
  const count = identity.registered.length
  const detail = `${version}, ${count} ${count === 1 ? 'channel' : 'channels'} to test`
  return {
    identity,
    check: unregistered.length
      ? {
          name,
          status: count ? 'ok' : 'problem',
          detail: `${detail}; never registered: ${unregistered.join(', ')}`,
          fix: 'Check those channel names, and load the hook before the app registers its IPC handlers.',
        }
      : { name, status: 'ok', detail },
  }
}

export async function runDoctor({
  cdp = 'http://127.0.0.1:9222',
  inspector = 'http://127.0.0.1:9229',
}: DoctorOptions = {}): Promise<DoctorReport> {
  const version = await packageVersion()
  const ipc = await ipcCheck(inspector, version)
  const checks = [
    nodeCheck(),
    ...(await playwrightChecks()),
    await cdpCheck(cdp),
    ipc.check,
  ]
  return {
    version,
    ok: checks.every((check) => check.status !== 'problem'),
    checks,
    ...(ipc.identity ? { ipc: ipc.identity } : {}),
  }
}
