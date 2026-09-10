#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { runCoreDemo } from '../examples/core-demo.mjs';
const report = await runCoreDemo();
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/core-demo.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.expectedDemonstrationVerified ? 0 : 1;
