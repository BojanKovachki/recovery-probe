/** Connection options a command line puts on top of a configuration file's own. */
export interface CommandLineOptions {
  cdp?: string
  page?: number
  inspector?: string
  restoreWindow?: boolean
}

/** The configuration with the command line's options on top; an option not given keeps the file's. */
export function withCommandLine(
  config: Record<string, unknown>,
  { cdp, page, inspector, restoreWindow }: CommandLineOptions,
): Record<string, unknown> {
  return {
    ...config,
    ...(cdp ? { cdp } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(inspector ? { inspector } : {}),
    ...(restoreWindow ? { restoreWindow: true } : {}),
  }
}
