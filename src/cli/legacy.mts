import { parseOptions, UsageError, type Values } from './args.mjs'

/** An old spelling, as the command and options that now do the same. */
export interface Translation {
  command: string
  values: Values
  /** The old spelling and its replacement, for the deprecation note. */
  was: string
  now: string
}

// Flags the old spellings took, as parseArgs options.
const flags = (booleans: string[], strings: string[]) =>
  Object.fromEntries([
    ...booleans.map((name) => [name, { type: 'boolean' as const }]),
    ...strings.map((name) => [name, { type: 'string' as const }]),
  ])

// Copies the given flags that were set, under the same names.
const pick = (values: Values, names: string[]): Values =>
  Object.fromEntries(
    names
      .filter((name) => values[name] !== undefined)
      .map((n) => [n, values[n]]),
  )

const one = (values: Values, names: string[], message: string) => {
  if (names.filter((name) => values[name]).length !== 1)
    throw new UsageError(message)
}

const translation = (
  command: string,
  values: Values,
  was: string,
  now = command,
): Translation => ({ command, values, was, now })

function root(args: string[]): Translation {
  const { values } = parseOptions(
    args,
    flags(['demo', 'json'], ['config', 'out']),
  )
  if (Boolean(values.demo) === Boolean(values.config))
    throw new UsageError('Choose exactly one of --demo or --config')
  // The old spelling wrote the report to one file, and only with --out.
  const output = { ...pick(values, ['json']), reportFile: values.out ?? false }
  return values.demo
    ? translation('demo', output, '--demo')
    : translation(
        'check',
        { ...output, config: values.config },
        '--config',
        'check --config',
      )
}

function desktop(args: string[], was = 'desktop'): Translation {
  const { values } = parseOptions(
    args,
    flags(
      ['list', 'discover', 'screenshots'],
      ['cdp', 'page', 'duration', 'out', 'config'],
    ),
  )
  one(
    values,
    ['list', 'discover', 'config'],
    'Choose one of --list, --discover, or --config',
  )
  if (values.list)
    return translation('windows', pick(values, ['cdp']), `${was} --list`)
  if (values.discover)
    return translation(
      'reads',
      { ...pick(values, ['cdp', 'page', 'duration', 'out']), reuseOut: true },
      `${was} --discover`,
    )
  return translation(
    'check',
    {
      ...pick(values, ['config', 'cdp', 'page', 'out', 'screenshots']),
      attach: true,
      reuseOut: true,
    },
    `${was} --config`,
    'check --config',
  )
}

function attach(args: string[]): Translation {
  // Listing windows and reads went through the desktop command.
  if (
    args.includes('--list') ||
    (args.includes('--discover') && !args.includes('--config'))
  )
    return desktop(args, 'web --attach')
  const { values } = parseOptions(
    args,
    flags(
      ['discover', 'screenshots', 'restore-window'],
      ['config', 'cdp', 'out', 'page'],
    ),
  )
  if (!values.config) throw new UsageError('--config is required')
  const common = pick(values, [
    'config',
    'cdp',
    'page',
    'out',
    'restore-window',
  ])
  if (values.discover)
    return translation(
      'discover',
      { ...common, ...pick(values, ['screenshots']) },
      'web --attach --discover --config',
      'discover --config',
    )
  if (values.screenshots) throw new UsageError('--screenshots needs --discover')
  return translation(
    'check',
    { ...common, attach: true, mode: 'attached browser recovery' },
    'web --attach --config',
    'check --config',
  )
}

function web(args: string[]): Translation {
  if (args.includes('--attach'))
    return attach(args.filter((arg) => arg !== '--attach'))
  const { values } = parseOptions(
    args,
    flags(['login', 'discover', 'headed'], ['url', 'state', 'config', 'out']),
  )
  one(
    values,
    ['login', 'discover', 'config'],
    'Choose --login, --discover, or --config',
  )
  if (values.login)
    return translation('login', pick(values, ['url', 'state']), 'web --login')
  if (values.discover)
    return translation(
      'reads',
      pick(values, ['url', 'state', 'out', 'headed']),
      'web --discover',
    )
  return translation(
    'check',
    { ...pick(values, ['config', 'state', 'headed', 'out']), launch: true },
    'web --config',
    'check --config',
  )
}

function ipc(args: string[]): Translation {
  const { values } = parseOptions(
    args,
    flags(
      ['discover', 'screenshots', 'action', 'restore-window'],
      ['config', 'out'],
    ),
  )
  if (!values.config) throw new UsageError('--config is required')
  if (values.discover && values.action)
    throw new UsageError('Use either --discover or --action')
  if (values.screenshots && !values.discover)
    throw new UsageError('--screenshots needs --discover')
  if (values.action)
    return translation(
      'action',
      pick(values, ['config', 'out']),
      'ipc --action',
    )
  if (values.discover)
    return translation(
      'discover',
      pick(values, ['config', 'out', 'screenshots', 'restore-window']),
      'ipc --discover',
    )
  return translation(
    'check',
    pick(values, ['config', 'out', 'restore-window']),
    'ipc --config',
    'check --config',
  )
}

const translators: Record<string, (args: string[]) => Translation> = {
  desktop,
  web,
  ipc,
}

/** How the old commands map to the new ones, for their --help. */
export const legacyHelp: Record<string, string> = {
  desktop: `recovery-probe desktop is now three commands:
  recovery-probe windows    was desktop --list
  recovery-probe reads      was desktop --discover
  recovery-probe check      was desktop --config`,
  web: `recovery-probe web is now:
  recovery-probe login      was web --login
  recovery-probe reads      was web --discover, and web --attach --discover without --config
  recovery-probe check      was web --config and web --attach --config
  recovery-probe discover   was web --attach --discover --config
  recovery-probe windows    was web --attach --list`,
  ipc: `recovery-probe ipc is now three commands:
  recovery-probe check      was ipc --config
  recovery-probe discover   was ipc --discover
  recovery-probe action     was ipc --action
They need the development hook in the app and its Node inspector; see docs/ipc.md.`,
}

/**
 * The new command an old spelling runs, or null when `argv` doesn't start with
 * one. The old spellings work until 1.0.
 */
export function translateLegacy(argv: string[]): Translation | null {
  if (argv[0]?.startsWith('--')) return root(argv)
  const translate = translators[argv[0]]
  return translate ? translate(argv.slice(1)) : null
}
