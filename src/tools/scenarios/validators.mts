import {
  withCommandLine,
  type CommandLineOptions,
} from '../../workflows/command-line.mjs'

/** A check's command-line flags: `--name value`, or `true` for `--name` alone. */
export type Flags = Record<string, string | true>

export function flagsOf(command: string[]): Flags {
  const flags: Flags = {}
  for (let i = 1; i < command.length; i++) {
    if (!command[i].startsWith('--')) continue
    const next = command[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[command[i]] = next
      i++
    } else flags[command[i]] = true
  }
  return flags
}

const textOf = (value: string | true | undefined) =>
  typeof value === 'string' ? value : undefined

function optionsOf(flags: Flags): CommandLineOptions {
  const page = textOf(flags['--page'])
  return {
    cdp: textOf(flags['--cdp']),
    page: page === undefined ? undefined : Number(page),
    inspector: textOf(flags['--inspector']),
    restoreWindow: flags['--restore-window'] !== undefined,
  }
}

export interface Validated {
  transport: 'http' | 'ipc' | 'browser'
  config: Record<string, unknown>
}

const asRecord = (value: unknown) => value as Record<string, unknown>

// The validators load on demand: the discover and JSON runner modules bring in Playwright.

async function checkCommand(
  config: Record<string, unknown>,
  { cdp, page, inspector, restoreWindow }: CommandLineOptions,
): Promise<Validated> {
  if (typeof config.channel === 'string') {
    const { validateIpcConfig } =
      await import('../../workflows/check/ipc/config.mjs')
    const input = withCommandLine(config, { cdp, inspector, restoreWindow })
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
  const http = await import('../../workflows/check/http/config.mjs')
  const input = http.attaches(config, cdp)
    ? http.attachedInput(config, { cdp, page })
    : http.launchedInput(config)
  return {
    transport: 'http',
    config: asRecord(http.validateDesktopConfig(input as never)),
  }
}

async function discoverCommand(
  config: Record<string, unknown>,
  options: CommandLineOptions,
): Promise<Validated> {
  const input = withCommandLine(config, options)
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
 * Validates a check's configuration with the validators its command uses, after putting the same
 * command-line options on top. Throws their error. Observe's steps are validated by `validateSteps`.
 */
export async function validateConfig(
  command: string[],
  config: Record<string, unknown>,
): Promise<Validated> {
  const options = optionsOf(flagsOf(command))
  switch (command[0]) {
    case 'check':
      return checkCommand(config, options)
    case 'discover':
      return discoverCommand(config, options)
    case 'action': {
      const { actionConfig } = await import('../../workflows/action/config.mjs')
      const { cdp, inspector } = options
      const input = withCommandLine(config, { cdp, inspector })
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

/** Validates observe's steps as `observe --steps` does with the command's other flags. */
export async function validateSteps(command: string[], steps: unknown) {
  const { observationSteps } = await import('../../workflows/observe/steps.mjs')
  const flags = flagsOf(command)
  observationSteps(steps, {
    network: Boolean(flags['--network']),
    requests: true,
    files: Boolean(flags['--files']),
  })
}

/** What must be running or present for the check to run. */
export function requirementsOf({ transport, config }: Validated, flags: Flags) {
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
  if (typeof flags['--network'] === 'string')
    requires.push(`a running recovery-probe net at ${flags['--network']}`)
  return requires
}
