import { ensure, ensureRanges, isUnique } from '../../core/validate.mjs'
import type { WebConfig } from '../../workflows/web.mjs'
import {
  validateDesktopConfig,
  type DesktopConfig,
  type ValidDesktopConfig,
} from '../../workflows/check/http/config.mjs'
import { validateCommand } from './process.mjs'
import { validateSourcePath } from './sources.mjs'

/** A repair run's configuration, validated: what to launch, test and read. */
export interface RepairConfig {
  target: 'web' | 'desktop'
  repo: string
  sourceFiles: string[]
  launch: string[]
  setup?: string[][]
  tests?: string[][]
  scenario: ValidDesktopConfig &
    Pick<WebConfig, 'storageState' | 'headless' | 'startupTimeoutMs'>
  manualLogin?: boolean
  startupTimeoutMs: number
  commandTimeoutMs: number
  provider?: Record<string, unknown>
}

const TIMEOUTS = [
  ['startupTimeoutMs', 200, 600000],
  ['commandTimeoutMs', 200, 600000],
] as const

/** Repair only drives a target it launches itself, at a loopback address. */
function loopback(value: string, protocols: string[]) {
  const url = new URL(value)
  ensure(
    protocols.includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password,
    'Repair must launch its own local development target at a loopback URL',
  )
}

function checkSourceFiles(sourceFiles: unknown) {
  ensure(
    Array.isArray(sourceFiles) &&
      sourceFiles.length > 0 &&
      sourceFiles.length <= 12 &&
      isUnique(sourceFiles),
    'sourceFiles must list 1–12 unique application source paths',
  )
  sourceFiles.forEach(validateSourcePath)
}

function checkCommands(raw: Record<string, unknown>) {
  validateCommand(raw.launch)
  for (const key of ['setup', 'tests']) {
    const commands = raw[key]
    ensure(
      commands === undefined || Array.isArray(commands),
      `${key} must be an array of commands`,
    )
    ;((commands as unknown[] | undefined) ?? []).forEach(validateCommand)
  }
}

function targetScenario(raw: Record<string, unknown>) {
  const scenario = validateDesktopConfig({
    recovery: 'automatic',
    ...(raw.scenario as DesktopConfig),
  })
  if (raw.target === 'web') loopback(scenario.pageUrl, ['http:', 'https:'])
  else loopback(scenario.cdp as string, ['http:'])
  return scenario
}

// A config comes from a JSON file, so every field is checked at runtime.
export function validateRepairConfig(input: unknown): RepairConfig {
  const raw = input as Record<string, unknown> | null | undefined
  ensure(
    raw && ['web', 'desktop'].includes(raw.target as string),
    'target must be web or desktop',
  )
  ensure(typeof raw.repo === 'string' && raw.repo, 'repo is required')
  checkSourceFiles(raw.sourceFiles)
  checkCommands(raw)
  const scenario = targetScenario(raw)
  const config = {
    startupTimeoutMs: 30000,
    commandTimeoutMs: 120000,
    ...raw,
    scenario,
  } as RepairConfig
  ensure(
    config.manualLogin === undefined || typeof config.manualLogin === 'boolean',
    'manualLogin must be boolean',
  )
  ensure(
    !config.manualLogin || config.target === 'desktop',
    'Web repair uses scenario.storageState; manualLogin is for Electron',
  )
  ensureRanges(config, TIMEOUTS)
  return config
}
