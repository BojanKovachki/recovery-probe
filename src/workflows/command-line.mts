import { integerOption, text, type Values } from '../core/options.mjs'

/** The options of the commands a registered check can run, as their command lines accept them. */
export const CHECK_COMMAND_OPTIONS = {
  check: {
    config: { type: 'string' },
    cdp: { type: 'string' },
    page: { type: 'string' },
    inspector: { type: 'string' },
    state: { type: 'string' },
    headed: { type: 'boolean' },
    screenshots: { type: 'boolean' },
    'restore-window': { type: 'boolean' },
    out: { type: 'string' },
    json: { type: 'boolean' },
  },
  discover: {
    config: { type: 'string' },
    cdp: { type: 'string' },
    page: { type: 'string' },
    inspector: { type: 'string' },
    screenshots: { type: 'boolean' },
    'restore-window': { type: 'boolean' },
    out: { type: 'string' },
    json: { type: 'boolean' },
  },
  action: {
    config: { type: 'string' },
    cdp: { type: 'string' },
    inspector: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean' },
  },
  observe: {
    config: { type: 'string' },
    out: { type: 'string' },
    steps: { type: 'string' },
    network: { type: 'string' },
    files: { type: 'string' },
    json: { type: 'boolean' },
    interactive: { type: 'boolean' },
  },
  refresh: {
    config: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean' },
  },
} as const

type Config = Record<string, unknown>

const pageOf = (values: Values) => integerOption(values, 'page', [0, 1000])

// What each command validates: its configuration file with its command line's options on top.

/** The configuration with the debugging port, Node inspector and window option given on top. */
export function withConnection(config: Config, values: Values): Config {
  const cdp = text(values, 'cdp')
  const inspector = text(values, 'inspector')
  return {
    ...config,
    ...(cdp ? { cdp } : {}),
    ...(inspector ? { inspector } : {}),
    ...(values['restore-window'] ? { restoreWindow: true } : {}),
  }
}

export function discoveryInput(config: Config, values: Values): Config {
  const page = pageOf(values)
  return {
    ...withConnection(config, values),
    ...(page !== undefined ? { page } : {}),
  }
}

/**
 * An HTTP check attaches to a running app or browser when the command line or the config names a
 * debugging port or page (port 9222 by default); otherwise it opens Chromium at pageUrl, where
 * recovery is automatic unless configured.
 */
export function httpCheckInput(config: Config, values: Values) {
  const cdp = text(values, 'cdp')
  if (
    cdp === undefined &&
    config.cdp === undefined &&
    config.page === undefined
  )
    return {
      attach: false,
      input: { recovery: 'automatic', ...config, target: 'web' } as Config,
    }
  const page = pageOf(values)
  return {
    attach: true,
    input: {
      ...config,
      ...(page !== undefined ? { page } : {}),
      cdp: cdp ?? config.cdp ?? 'http://127.0.0.1:9222',
    } as Config,
  }
}
