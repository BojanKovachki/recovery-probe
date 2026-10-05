import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { prepareRepair, generateRepair, verifyRepair } from '../src/repair.mjs';

export async function repairMain(args) {
  if (!args.length || args.includes('--help')) {
    console.log(`Recovery Probe repair preview — local development only
  recovery-probe repair --config repair.json --out NEW_DIRECTORY --allow-execution
  recovery-probe repair --generate RUN_DIRECTORY --allow-source-upload
  recovery-probe repair --verify RUN_DIRECTORY --allow-execution

Optional single run: --config ... --out ... --allow-execution --allow-source-upload --auto-verify

Config: target (web/desktop), repo, sourceFiles, scenario, launch, setup, tests, provider.model.
Paths resolve relative to the config. Output must be outside your clean source repository.
Step 1 clones the committed source locally, starts that copy and reproduces a failure.
Step 2 sends only repair-request.json to OpenAI, using your local OPENAI_API_KEY.
Step 3 applies proposal.json only to the copy and reruns the same scenario and your tests.
Review proposal.json before verification. --auto-verify explicitly executes unreviewed AI code.
A checkout is NOT a security sandbox: use a disposable dev container/VM and test accounts.
There is no implicit source upload, production deployment, commit, merge or original-repo edit.
See docs/repair.md for complete web and Electron examples and Windows commands.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--allow-execution', '--allow-source-upload', '--auto-verify'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--config', '--out', '--generate', '--verify'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = args[++i];
    } else throw new Error(`Unknown repair option: ${arg}`);
  }
  if ([options.config, options.generate, options.verify].filter(Boolean).length !== 1) throw new Error('Choose --config, --generate, or --verify');
  if (options['auto-verify'] && (!options.config || !options['allow-execution'] || !options['allow-source-upload'])) throw new Error('--auto-verify requires --config, --allow-execution and --allow-source-upload');
  let directory = resolve(options.generate ?? options.verify ?? options.out ?? `../recovery-probe-run-${Date.now()}`);
  if (options.verify) {
    const result = await verifyRepair(directory, { allowExecution: options['allow-execution'] });
    console.log(JSON.stringify(result, null, 2));
    console.log(`Review ${directory}/candidate.patch. Your original repository was not modified.`);
    process.exitCode = result.status === 'verified-candidate' ? 0 : 1;
    return;
  }
  if (options.config) {
    const configPath = resolve(options.config);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.repo = resolve(dirname(configPath), config.repo ?? '.');
    if (config.scenario?.storageState) config.scenario.storageState = resolve(dirname(configPath), config.scenario.storageState);
    console.log('Reproducing in a separate checkout; running only the commands you configured.');
    const prepared = await prepareRepair(config, directory, { allowExecution: options['allow-execution'] });
    if (!prepared.reproduced) {
      console.log(`No repairable failure reproduced. Inspect ${directory}/before.json; no model called.`);
      process.exitCode = prepared.before.ok ? 0 : 2;
      return;
    }
    console.log(`Failure reproduced. Inspect ${directory}/repair-request.json before authorizing source upload.`);
    if (!options['allow-source-upload']) return;
  }
  const proposal = await generateRepair(directory, { allowSourceUpload: options['allow-source-upload'] });
  console.log(`Proposal: ${directory}/proposal.json (${proposal.edits.length} edit(s)). No source changes applied yet.`);
  if (options['auto-verify'] && proposal.edits.length) {
    const result = await verifyRepair(directory, { allowExecution: true });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'verified-candidate' ? 0 : 1;
  } else console.log('Review the proposal, then run repair --verify RUN_DIRECTORY --allow-execution.');
}
