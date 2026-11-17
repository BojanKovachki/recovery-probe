import type { Values } from '../../core/options.mjs'
import {
  discoveryInput,
  httpCheckInput,
  withConnection,
} from '../../workflows/command-line.mjs'

export interface Validated {
  transport: 'http' | 'ipc' | 'browser'
  config: Record<string, unknown>
}

const asRecord = (value: unknown) => value as Record<string, unknown>

// The validators load on demand: the discover and JSON runner modules bring in Playwright.

async function checkCommand(
  config: Record<string, unknown>,
  values: Values,
): Promise<Validated> {
  if (typeof config.channel === 'string') {
    const { validateIpcConfig } =
      await import('../../workflows/check/ipc/config.mjs')
    const input = withConnection(config, values)
    return {
      transport: 'ipc',
      config: asRecord(validateIpcConfig(input as never)),
    }
  }
  if (typeof config.requestPattern === 'string') {
    const { checkScenario } = await import('../../workflows/check/browser.mjs')
    checkScenario(config as never)
    return { transport: 'browser', config }
  }
  const { validateDesktopConfig } =
    await import('../../workflows/check/http/config.mjs')
  const { input } = httpCheckInput(config, values)
  return {
    transport: 'http',
    config: asRecord(validateDesktopConfig(input as never)),
  }
}

async function discoverCommand(
  config: Record<string, unknown>,
  values: Values,
): Promise<Validated> {
  const input = discoveryInput(config, values)
  if (typeof config.channel === 'string') {
    const { discoveryConfig } = await import('../../workflows/discover/ipc.mjs')
    return {
      transport: 'ipc',
      config: asRecord(discoveryConfig(input as never)),
    }
  }
  const { httpDiscoveryConfig } =
    await import('../../workflows/discover/http.mjs')
  return { transport: 'http', config: asRecord(httpDiscoveryConfig(input)) }
}

/**
 * Validates a check's configuration as command `name` does, with the options of its parsed
 * command line on top. Throws their error. Observe's steps are validated by `validateSteps`.
 */
export async function validateConfig(
  name: string,
  values: Values,
  config: Record<string, unknown>,
): Promise<Validated> {
  switch (name) {
    case 'check':
      return checkCommand(config, values)
    case 'discover':
      return discoverCommand(config, values)
    case 'action': {
      const { actionConfig } = await import('../../workflows/action/config.mjs')
      const input = withConnection(config, values)
      return { transport: 'ipc', config: asRecord(actionConfig(input)) }
    }
    case 'refresh': {
      const { refreshConfig } =
        await import('../../workflows/refresh/config.mjs')
      const valid = asRecord(refreshConfig(config))
      return { transport: valid.transport as 'http' | 'ipc', config: valid }
    }
    default: {
      const { observationConfig } =
        await import('../../workflows/observe/config.mjs')
      const valid = asRecord(observationConfig(config))
      return { transport: valid.transport as 'http' | 'ipc', config: valid }
    }
  }
}

/** Validates observe's steps as `observe --steps` does with the command's other options. */
export async function validateSteps(values: Values, steps: unknown) {
  const { observationSteps } = await import('../../workflows/observe/steps.mjs')
  observationSteps(steps, {
    network: Boolean(values.network),
    requests: true,
    files: Boolean(values.files),
  })
}

/** What must be running or present for the check to run. */
export function requirementsOf(
  { transport, config }: Validated,
  values: Values,
) {
  const requires: string[] = []
  if (transport === 'browser')
    requires.push(
      `the page at ${config.url}, which the check opens in its own Chromium`,
    )
  else if (typeof config.cdp === 'string')
    requires.push(`an app or browser with a debugging port at ${config.cdp}`)
  else if (typeof config.pageUrl === 'string')
    requires.push(
      `the page at ${config.pageUrl}, which the check opens in its own Chromium`,
    )
  if (transport === 'ipc')
    requires.push(
      `the Recovery Probe IPC hook in the app, reached through the Node inspector at ${config.inspector}`,
    )
  if (typeof values.network === 'string')
    requires.push(`a running recovery-probe net at ${values.network}`)
  return requires
}
