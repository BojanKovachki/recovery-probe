import { choose, chooseMany, type StartIo } from './guided-start.mjs'
import { identifyIpcHook, probeJson } from './doctor.mjs'
import type { IpcIdentity } from './ipc-probe.cjs'

/** What `init` found to test. */
export type InitTarget =
  | { kind: 'web'; url: string }
  | { kind: 'desktop'; cdp: string; hookError?: string }
  | { kind: 'ipc'; cdp: string; inspector: string; identity: IpcIdentity }
  | { kind: 'none' }

export interface InitProbes {
  json: typeof probeJson
  identify: typeof identifyIpcHook
}

export async function detectTarget(
  {
    url,
    cdp = 'http://127.0.0.1:9222',
    inspector = 'http://127.0.0.1:9229',
  }: { url?: string; cdp?: string; inspector?: string },
  probes: InitProbes = { json: probeJson, identify: identifyIpcHook },
): Promise<InitTarget> {
  if (url) return { kind: 'web', url }
  if (!(await probes.json(new URL('/json/version', cdp).href)))
    return { kind: 'none' }
  if (!(await probes.json(new URL('/json/list', inspector).href)))
    return { kind: 'desktop', cdp }
  const result = await probes.identify(inspector)
  return 'identity' in result
    ? { kind: 'ipc', cdp, inspector, identity: result.identity }
    : { kind: 'desktop', cdp, hookError: result.error }
}

/** Asks which channel loads the screen and which others it needs. */
export async function chooseIpcScenario(
  identity: IpcIdentity,
  io: StartIo,
  { cdp, inspector }: { cdp: string; inspector: string },
) {
  // Only channels the hook allows and the app registered are recorded, so these can all be failed.
  const channels = identity.registered
  if (!channels.length)
    throw new Error(
      "The app hasn't registered any of the hook's channels. Check the names in its channels option, and load the hook before the IPC handlers are registered.",
    )
  const channel = await choose(
    io,
    'Which channel loads the screen you want to test?',
    channels.map((c) => ({ label: c, value: c })),
  )
  const requiredChannels = await chooseMany(
    io,
    'Which of these does the screen also need?',
    channels.filter((c) => c !== channel).map((c) => ({ label: c, value: c })),
  )
  return { channel, requiredChannels, cdp, inspector }
}
