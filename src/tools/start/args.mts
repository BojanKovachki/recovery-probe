export interface StartOptions {
  target: 'web' | 'desktop'
  url?: string
  fresh?: boolean
  headless?: boolean
  cdp?: string
  dir?: string
}

/** Reads the argument at `i` into `options`; returns the index of the last one it used. */
function readArg(args: string[], i: number, options: Record<string, unknown>) {
  const arg = args[i]
  if (['--fresh', '--headless'].includes(arg)) options[arg.slice(2)] = true
  else if (['--cdp', '--dir'].includes(arg)) {
    if (!args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error(`${arg} needs a value`)
    options[arg.slice(2)] = args[i + 1]
    return i + 1
  } else if (options.target === 'web' && !options.url && !arg.startsWith('--'))
    options.url = arg
  else throw new Error(`Unknown start option: ${arg}`)
  return i
}

export function parseStartArgs(args: string[]): StartOptions {
  const options: Record<string, unknown> = { target: args[0] }
  if (!['web', 'desktop'].includes(options.target as string))
    throw new Error('Use start web [URL] or start desktop')
  for (let i = 1; i < args.length; i++) i = readArg(args, i, options)
  if (options.target === 'web' && options.cdp)
    throw new Error('--cdp is only for desktop')
  if (options.target === 'desktop' && options.headless)
    throw new Error('--headless is only for saved web checks')
  return options as unknown as StartOptions
}
