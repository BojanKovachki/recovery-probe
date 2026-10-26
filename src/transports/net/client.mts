import type { NetworkFaultControl, NetworkFaultSummary } from './types.mjs'

export const CONTROL_PATH = '/recovery-probe/network/'
export const CONTROL_HEADER = 'x-recovery-probe'

/** Controls a proxy started with `control: true`, such as `recovery-probe net`. */
export function connectNetworkFaults(url: string): NetworkFaultControl {
  const base = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
    throw new TypeError('The network control must be a loopback URL')
  const call = async (action: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(`${CONTROL_PATH}${action}`, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { [CONTROL_HEADER]: 'network' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const result = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    if (!response.ok)
      throw new Error(
        `Network control ${action} failed (${response.status})${result.error ? `: ${result.error}` : ''}`,
      )
    return result
  }
  return {
    arm: async (rules) => void (await call('arm', { rules })),
    disarm: async () => void (await call('disarm', {})),
    dropOpen: async (host) =>
      ((await call('drop', { host })) as { dropped: number }).dropped,
    summary: async () => (await call('summary')) as NetworkFaultSummary,
  }
}
