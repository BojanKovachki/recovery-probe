import { access, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { connectDesktop, desktopPages, pageIdentity, discoverDesktop, checkDesktop } from './desktop.mjs';
import { writeDesktopReport } from './desktop-report.mjs';
import { pickMarker } from './pick-marker.mjs';

const require = createRequire(import.meta.url);
const safeLabel = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 240);

export function parseStartArgs(args) {
  const options = { target: args[0] };
  if (!['web', 'desktop'].includes(options.target)) throw new Error('Use start web [URL] or start desktop');
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (['--fresh', '--headless'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--cdp', '--dir'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = args[++i];
    } else if (options.target === 'web' && !options.url && !arg.startsWith('--')) options.url = arg;
    else throw new Error(`Unknown start option: ${arg}`);
  }
  if (options.target === 'web' && options.cdp) throw new Error('--cdp is only for desktop');
  if (options.target === 'desktop' && options.headless) throw new Error('--headless is only for saved web checks');
  return options;
}

export async function choose(io, prompt, choices) {
  if (!choices.length) throw new Error(`No choices available: ${prompt}`);
  if (choices.length === 1) { io.log(`Selected: ${safeLabel(choices[0].label)}`); return choices[0].value; }
  io.log(prompt);
  choices.forEach((choice, index) => io.log(`  ${index + 1}. ${safeLabel(choice.label)}`));
  while (true) {
    const answer = (await io.ask('Choose a number: ')).trim();
    if (/^[1-9]\d*$/.test(answer) && choices[Number(answer) - 1]) return choices[Number(answer) - 1].value;
    io.log('Enter one of the displayed numbers.');
  }
}

async function launchWeb(options, io) {
  let playwright;
  try { playwright = await import('playwright'); }
  catch { throw new Error('Install the browser adapter: npm install --save-dev playwright@1.62.1'); }
  // Install the browser automatically only if it is missing, never for other launch errors.
  try { await access(playwright.chromium.executablePath()); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    io.log('Downloading Chromium for the first run…');
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', shell: false });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Chromium installation failed. Run npx playwright install chromium, then retry.')));
    });
  }
  return playwright.chromium.launch({ headless: Boolean(options.headless) });
}

async function readSaved(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function configurePage(page, io, { durationMs = 5000, pick = pickMarker } = {}) {
  io.log('Discovering GET JSON requests by reloading this screen…');
  const discovery = await discoverDesktop(page, { durationMs });
  if (!discovery.endpoints.length) throw new Error('No supported GET JSON requests were found. This is inconclusive: the screen may use native/Rust/IPC, POST, cached data, service workers, or require another screen. No fault checks ran.');
  const endpoint = await choose(io, 'Which request supplies the content you want to check?', discovery.endpoints.map(item => ({ label: item.endpoint, value: item.endpoint })));
  io.log('In the app, click one loaded piece of content supplied by that request. Avoid headings, menus, clocks and loading indicators.');
  let marker;
  while (true) {
    marker = await pick(page);
    io.log(`Selected content: ${safeLabel(marker.readyText ?? marker.readySelector)}`);
    const accepted = await choose(io, 'Does this content demonstrate that the selected request loaded correctly?', [
      { label: 'Yes, use this content', value: true }, { label: 'No, pick again', value: false },
    ]);
    if (accepted) break;
  }
  const recovery = await choose(io, 'How should this screen recover?', [
    { label: 'Automatically, without a click', value: 'automatic' },
    { label: 'A user clicks a Retry button', value: 'retry' },
  ]);
  const config = { pageUrl: page.url(), endpoint, ...marker, recovery, timeoutMs: 15000 };
  if (recovery === 'retry') {
    // The button may only appear after failure. Match its accessible name rather
    // than making the user write a selector or clicking a guessed control.
    const label = (await io.ask('Retry button label [Retry]: ')).trim() || 'Retry';
    config.retrySelector = `role=button[name=${JSON.stringify(label)}s]`;
  }
  const deadline = (await io.ask('Recovery deadline in seconds [15]: ')).trim();
  if (deadline) {
    if (!/^\d+$/.test(deadline) || Number(deadline) < 1 || Number(deadline) > 60) throw new Error('Recovery deadline must be 1–60 seconds.');
    config.timeoutMs = Number(deadline) * 1000;
  }
  return config;
}

/** Interactive setup once; subsequent runs use the saved assertion and auth locally. */
export async function runStart(options, io, dependencies = {}) {
  const directory = resolve(options.dir ?? join('.recovery-probe', 'start', options.target));
  const setupPath = join(directory, 'setup.json');
  const saved = options.fresh ? null : await readSaved(setupPath);
  if (saved && (saved.schemaVersion !== 1 || saved.target !== options.target)) throw new Error('Saved setup is incompatible; choose a different --dir or use --fresh.');
  if (saved && options.url && options.url !== saved.requestedUrl) throw new Error('This folder has another URL saved. Use --fresh to configure this URL, or --dir for a separate setup.');
  if (!saved && options.headless) throw new Error('First setup needs the visible browser. Remove --headless.');
  if (!saved && !io.interactive) throw new Error('First setup requires an interactive terminal. Reruns can use the saved setup.');
  let requestedUrl = saved?.requestedUrl ?? options.url;
  if (options.target === 'web') {
    requestedUrl ??= (await io.ask('Local development URL: ')).trim();
    const url = new URL(requestedUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.');
  }
  // Keep all state private and ignored even when invoked inside an existing repo.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 });
  let browser;
  let context;
  let page;
  const cdp = options.cdp ?? saved?.config.cdp ?? 'http://127.0.0.1:9222';
  try {
    if (options.target === 'web') {
      browser = await (dependencies.launchWeb ?? launchWeb)(options, io);
      context = await browser.newContext({ serviceWorkers: 'block', ...(saved?.config.storageState ? { storageState: saved.config.storageState } : {}) });
      page = await context.newPage();
      await page.goto(saved?.config.pageUrl ?? requestedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      try { browser = await (dependencies.connectDesktop ?? connectDesktop)(cdp); }
      catch (error) { throw new Error(`Cannot attach to Electron at ${cdp}. Start its development build with --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 (or use --cdp for your port). The flags must reach Electron, not only its frontend server. ${error.message}`); }
      const pages = desktopPages(browser);
      const matching = saved ? pages.filter(item => pageIdentity(item.url()) === pageIdentity(saved.config.pageUrl)) : pages;
      if (!matching.length) throw new Error('No matching app window found. Open the saved screen, or run start desktop --fresh to select a new screen.');
      page = await choose(io, 'Choose the app window:', await Promise.all(matching.map(async item => ({ label: `${await item.title()} — ${pageIdentity(item.url())}`, value: item }))));
      await page.bringToFront();
    }
    let config;
    if (!saved) {
      io.log('Use a development/test account. Checks reload this screen and inject request failures. Source code is not read or uploaded.');
      await io.ask('Sign in if needed, open the screen to test, then press Enter here: ');
      config = await configurePage(page, io, dependencies);
      config.target = options.target;
      if (options.target === 'desktop') config.cdp = cdp;
      else {
        // A new name keeps existing saved sessions intact if setup is interrupted.
        const stateDir = await mkdtemp(join(directory, 'session-'));
        config.storageState = join(stateDir, 'auth.json');
        await writeFile(config.storageState, JSON.stringify(await context.storageState({ indexedDB: true })), { mode: 0o600 });
        io.log('Login state is saved locally. Session-storage-only login is not supported on reruns. Keep this folder private.');
      }
      await writeFile(setupPath, JSON.stringify({ schemaVersion: 1, target: options.target, requestedUrl, config }, null, 2), { mode: 0o600 });
    } else {
      config = { ...saved.config, ...(options.target === 'desktop' ? { cdp } : {}) };
      io.log('Using the saved request, recovery expectation and selected content. Use --fresh to change them or refresh login.');
    }
    const report = await checkDesktop(page, config);
    report.mode = `${options.target} guided recovery`;
    const output = await mkdtemp(join(directory, 'run-'));
    await writeDesktopReport(output, report, config);
    for (const row of report.results) io.log(`${row.outcome.toUpperCase()}: ${row.kind} — ${row.code}`);
    io.log(`Report: ${join(output, 'report.html')}`);
    io.log(`Rerun: npx recovery-probe start ${options.target}${options.dir ? ' --dir ' + JSON.stringify(options.dir) : ''}`);
    if (report.results.some(row => row.code === 'BASELINE_FAILED')) io.log('The healthy baseline failed. Check login, the selected content and the endpoint; use --fresh to set up again.');
    return { report, config, output, exitCode: report.ok ? 0 : report.results.some(row => row.outcome === 'fail') ? 1 : 2 };
  } finally { if (browser) await browser.close(); }
}
