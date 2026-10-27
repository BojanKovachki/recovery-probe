import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { pageIdentity } from '../../core/urls.mjs'
import { writeDesktopReport } from '../../reports/check.mjs'
import { connectDesktop, desktopPages } from '../../targets/cdp.mjs'
import {
  checkDesktop,
  type DesktopReport,
} from '../../workflows/check/http/run.mjs'
import { choose, type StartIo } from '../ask.mjs'
import type { StartOptions } from './args.mjs'
import { launchWeb } from './browser.mjs'
import {
  configurePage,
  type ConfigureOptions,
  type GuidedConfig,
} from './configure.mjs'

interface SavedSetup {
  schemaVersion: number
  target: string
  requestedUrl?: string
  config: GuidedConfig
}

export interface StartDependencies extends ConfigureOptions {
  launchWeb?: (options: StartOptions, io: StartIo) => Promise<Browser>
  connectDesktop?: (cdp: string) => Promise<Browser>
}

export interface StartResult {
  report: DesktopReport
  config: GuidedConfig
  output: string
  exitCode: 0 | 1 | 2
}

async function readSaved(path: string): Promise<SavedSetup | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function checkSaved(
  saved: SavedSetup | null,
  options: StartOptions,
  io: StartIo,
) {
  if (saved && (saved.schemaVersion !== 1 || saved.target !== options.target))
    throw new Error(
      'Saved setup is incompatible; choose a different --dir or use --fresh.',
    )
  if (saved && options.url && options.url !== saved.requestedUrl)
    throw new Error(
      'This folder has another URL saved. Use --fresh to configure this URL, or --dir for a separate setup.',
    )
  if (!saved && options.headless)
    throw new Error('First setup needs the visible browser. Remove --headless.')
  if (!saved && !io.interactive)
    throw new Error(
      'First setup requires an interactive terminal. Reruns can use the saved setup.',
    )
}

function checkWebUrl(value: string) {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Use an HTTP(S) URL without embedded credentials.')
}

/** Interactive setup once; subsequent runs use the saved assertion and auth locally. */
export function runStart(
  options: StartOptions,
  io: StartIo,
  dependencies: StartDependencies = {},
): Promise<StartResult> {
  return new StartRun(options, io, dependencies).run()
}

class StartRun {
  readonly #options: StartOptions
  readonly #io: StartIo
  readonly #dependencies: StartDependencies
  readonly #directory: string
  readonly #setupPath: string
  #saved: SavedSetup | null = null
  #requestedUrl: string | undefined
  #cdp = ''
  #browser: Browser | undefined
  #context: BrowserContext | undefined

  constructor(
    options: StartOptions,
    io: StartIo,
    dependencies: StartDependencies,
  ) {
    this.#options = options
    this.#io = io
    this.#dependencies = dependencies
    this.#directory = resolve(
      options.dir ?? join('.recovery-probe', 'start', options.target),
    )
    this.#setupPath = join(this.#directory, 'setup.json')
  }

  async run(): Promise<StartResult> {
    await this.#load()
    // Keep all state private and ignored even when invoked inside an existing repo.
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await writeFile(join(this.#directory, '.gitignore'), '*\n', {
      mode: 0o600,
    })
    const saved = this.#saved
    this.#cdp =
      this.#options.cdp ?? saved?.config.cdp ?? 'http://127.0.0.1:9222'
    try {
      const page =
        this.#options.target === 'web'
          ? await this.#openWeb()
          : await this.#openDesktop()
      const config = saved ? this.#savedConfig(saved) : await this.#setUp(page)
      return await this.#check(page, config)
    } finally {
      if (this.#browser) await this.#browser.close()
    }
  }

  async #load() {
    const options = this.#options
    const saved = options.fresh ? null : await readSaved(this.#setupPath)
    checkSaved(saved, options, this.#io)
    this.#saved = saved
    let requestedUrl = saved?.requestedUrl ?? options.url
    if (options.target === 'web') {
      requestedUrl ??= (await this.#io.ask('Local development URL: ')).trim()
      checkWebUrl(requestedUrl)
    }
    this.#requestedUrl = requestedUrl
  }

  async #openWeb() {
    const saved = this.#saved
    const launch = this.#dependencies.launchWeb ?? launchWeb
    const browser = await launch(this.#options, this.#io)
    this.#browser = browser
    const context = await browser.newContext({
      serviceWorkers: 'block',
      ...(saved?.config.storageState
        ? { storageState: saved.config.storageState }
        : {}),
    })
    this.#context = context
    const page = await context.newPage()
    // A web setup always has a URL: saved, given, or asked for above.
    await page.goto((saved?.config.pageUrl ?? this.#requestedUrl)!, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    return page
  }

  async #openDesktop() {
    const connect = this.#dependencies.connectDesktop ?? connectDesktop
    let browser: Browser
    try {
      browser = await connect(this.#cdp)
    } catch (error) {
      throw new Error(
        `${(error as Error).message} The flags must reach Electron itself, not only its frontend server; use --cdp for another port.`,
        { cause: error },
      )
    }
    this.#browser = browser
    const page = await choose(
      this.#io,
      'Choose the app window:',
      await Promise.all(
        this.#savedWindows(desktopPages(browser)).map(async (item) => ({
          label: `${await item.title()} — ${pageIdentity(item.url())}`,
          value: item,
        })),
      ),
    )
    await page.bringToFront()
    return page
  }

  /** The windows on the saved screen, or every window for a first setup. */
  #savedWindows(pages: Page[]) {
    const saved = this.#saved
    const matching = saved
      ? pages.filter(
          (item) =>
            pageIdentity(item.url()) === pageIdentity(saved.config.pageUrl),
        )
      : pages
    if (!matching.length)
      throw new Error(
        'No matching app window found. Open the saved screen, or run start desktop --fresh to select a new screen.',
      )
    return matching
  }

  #savedConfig(saved: SavedSetup): GuidedConfig {
    this.#io.log(
      'Using the saved request, recovery expectation and selected content. Use --fresh to change them or refresh login.',
    )
    return {
      ...saved.config,
      ...(this.#options.target === 'desktop' ? { cdp: this.#cdp } : {}),
    }
  }

  async #setUp(page: Page): Promise<GuidedConfig> {
    const io = this.#io
    const target = this.#options.target
    io.log(
      'Use a development/test account. Checks reload this screen and inject request failures. Source code is not read or uploaded.',
    )
    await io.ask(
      'Sign in if needed, open the screen to test, then press Enter here: ',
    )
    const config = await configurePage(page, io, this.#dependencies)
    config.target = target
    if (target === 'desktop') config.cdp = this.#cdp
    else config.storageState = await this.#saveLogin()
    await writeFile(
      this.#setupPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          target,
          requestedUrl: this.#requestedUrl,
          config,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    return config
  }

  async #saveLogin() {
    // A new name keeps existing saved sessions intact if setup is interrupted.
    const stateDir = await mkdtemp(join(this.#directory, 'session-'))
    const path = join(stateDir, 'auth.json')
    await writeFile(
      path,
      // The web branch opened this context.
      JSON.stringify(await this.#context!.storageState({ indexedDB: true })),
      { mode: 0o600 },
    )
    this.#io.log(
      'Login state is saved locally. Session-storage-only login is not supported on reruns. Keep this folder private.',
    )
    return path
  }

  async #check(page: Page, config: GuidedConfig): Promise<StartResult> {
    const { target, dir } = this.#options
    const io = this.#io
    const report = await checkDesktop(page, config)
    report.mode = `${target} guided recovery`
    const output = await mkdtemp(join(this.#directory, 'run-'))
    await writeDesktopReport(output, report, config)
    for (const row of report.results)
      io.log(`${row.outcome.toUpperCase()}: ${row.kind} — ${row.code}`)
    io.log(`Report: ${join(output, 'report.html')}`)
    io.log(
      `Rerun: npx recovery-probe start ${target}${dir ? ' --dir ' + JSON.stringify(dir) : ''}`,
    )
    if (report.results.some((row) => row.code === 'BASELINE_FAILED'))
      io.log(
        'The healthy baseline failed. Check login, the selected content and the endpoint; use --fresh to set up again.',
      )
    return { report, config, output, exitCode: exitCodeOf(report) }
  }
}

const exitCodeOf = (report: DesktopReport): 0 | 1 | 2 => {
  if (report.ok) return 0
  return report.results.some((row) => row.outcome === 'fail') ? 1 : 2
}
