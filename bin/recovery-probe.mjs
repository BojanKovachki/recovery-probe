#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { probeRecovery } from '../src/index.mjs';
import { startDemoServer } from '../examples/demo-server.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function printHelp() {
  console.log(`Recovery Probe ${version}

Usage:
  recovery-probe --demo [--out report.json] [--json]
  recovery-probe --config scenario.json [--out report.json] [--json]
  recovery-probe desktop --help
  recovery-probe web --help
  recovery-probe repair --help
  recovery-probe --version

Options:
  --demo           Run the included broken-versus-fixed browser demonstration.
  --config <file>  Check one JSON-configured recovery scenario.
  --out <file>     Save the full machine-readable report.
  --json           Print the full JSON report instead of a terminal summary.
  --help           Show this help.

Use only development or test targets you control.`);
}

function marker(outcome) {
  if (outcome === 'pass') return 'PASS';
  if (outcome === 'fail') return 'CAUGHT';
  return outcome.toUpperCase();
}

function printSummary(report) {
  console.log(`Recovery Probe ${report.version} — ${report.mode}\n`);
  for (const app of report.apps) {
    console.log(app.name);
    for (const row of app.results) {
      const injected = row.applied ? `, injected ${row.applied}` : '';
      console.log(`  ${marker(row.outcome).padEnd(12)} ${row.scenario} (${row.code}${injected})`);
    }
    console.log('');
  }
  if (report.mode === 'controlled demonstration') {
    console.log(report.expectedDemonstrationVerified
      ? 'Demo verified: the happy path passes, the broken recovery is caught, and the fixed app recovers.'
      : 'Demo failed: the expected broken-versus-fixed distinction was not observed.');
  } else {
    console.log(report.apps.every(app => app.ok) ? 'Recovery check passed.' : 'Recovery check did not pass.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'web') {
    const { webMain } = await import('./web.mjs');
    return webMain(args.slice(1));
  }
  if (args[0] === 'repair') {
    const { repairMain } = await import('./repair.mjs');
    return repairMain(args.slice(1));
  }
  if (args[0] === 'desktop') {
    const { desktopMain } = await import('./desktop.mjs');
    return desktopMain(args.slice(1));
  }
  if (args.includes('--help') || !args.length) {
    printHelp();
    return;
  }
  if (args.length === 1 && args[0] === '--version') {
    console.log(version);
    return;
  }
  let demo = false;
  let json = false;
  let configPath;
  let output;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--demo') demo = true;
    else if (arg === '--json') json = true;
    else if (arg === '--config' || arg === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--config') configPath = value; else output = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (demo === Boolean(configPath)) throw new Error('Choose exactly one of --demo or --config');

  const config = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  let server;
  let report;
  try {
    const apps = [];
    if (demo) {
      server = await startDemoServer();
      for (const variant of ['broken', 'fixed']) {
        apps.push(await probeRecovery(browser, {
          name: `${variant} synthetic fixture`, url: `${server.url}/${variant}`,
          requestPattern: '**/api/profile', readySelector: '#profile', retrySelector: '#retry', timeoutMs: 1200,
        }));
      }
    } else apps.push(await probeRecovery(browser, config));
    report = {
      tool: 'Recovery Probe', version, generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, chromium: browser.version() },
      mode: demo ? 'controlled demonstration' : 'configured recovery check', apps,
    };
    if (demo) {
      report.expectedDemonstrationVerified = apps[0].results[0].outcome === 'pass'
        && apps[0].results.slice(1).every(row => row.outcome === 'fail' && row.applied === 1)
        && apps[1].ok;
      process.exitCode = report.expectedDemonstrationVerified ? 0 : 1;
    } else process.exitCode = apps.every(app => app.ok) ? 0 : 1;
  } finally {
    await browser.close();
    if (server) await server.close();
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
}

main().catch(error => {
  console.error(`Recovery Probe: ${error.message}`);
  process.exitCode = 2;
});
