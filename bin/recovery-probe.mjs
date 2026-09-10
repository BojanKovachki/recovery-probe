#!/usr/bin/env node
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { probeRecovery } from '../src/index.mjs';
import { startDemoServer } from '../examples/demo-server.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) {
    console.log('Recovery Probe 0.1 prototype\n  --demo [--out file.json]\n  --config scenario.json [--out file.json]\nUse a development/test target you control. The JSON runner handles auto-loading GET pages with a Retry button.');
    return;
  }
  let demo = false;
  let configPath;
  let output;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--demo') demo = true;
    else if (arg === '--config' || arg === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--config') configPath = value; else output = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (demo === Boolean(configPath)) throw new Error('Choose exactly one of --demo or --config');

  const config = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : null;
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
      prototype: 'Recovery Probe 0.1', generatedAt: new Date().toISOString(),
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
  console.log(JSON.stringify(report, null, 2));
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
}

main().catch(error => {
  console.error(`Recovery Probe: ${error.message}`);
  process.exitCode = 2;
});
