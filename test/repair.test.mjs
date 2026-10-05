import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepairConfig, validateSourcePath, applyProposalToSources, prepareRepair } from '../src/repair.mjs';
import { proposeRepair } from '../src/repair-provider.mjs';
import { runCommand, executionEnvironment } from '../src/repair-process.mjs';

const config = { target: 'web', repo: '.', sourceFiles: ['src/profile.ts'], launch: ['node', 'server.mjs'], scenario: { pageUrl: 'http://127.0.0.1:3100', endpoint: 'http://127.0.0.1:3100/api/profile', readySelector: '#profile' } };
test('repair rejects traversal, secrets, tests, config files and invalid commands', () => {
  for (const path of ['../src/a.js', '/tmp/a.js', 'src/../../a.js', 'src\\a.js', '.env', '.git/config', 'test/a.js', 'src/a.test.ts', 'src/a.spec.ts', 'src/config.json', 'src/a.config.ts', 'src/.secret.js', 'node_modules/a.js']) assert.throws(() => validateSourcePath(path));
  for (const source of ['src/a.tsx', 'src/a.mjs', 'apps/portal/src/page.vue']) assert.equal(validateSourcePath(source), source);
  assert.equal(validateRepairConfig(config).scenario.recovery, 'automatic');
  assert.throws(() => validateRepairConfig({ ...config, launch: 'npm run dev' }));
  assert.throws(() => validateRepairConfig({ ...config, scenario: { ...config.scenario, pageUrl: 'https://production.example' } }), /loopback/);
  assert.throws(() => validateRepairConfig({ ...config, target: 'desktop', scenario: { ...config.scenario, cdp: 'http://0.0.0.0:9222' } }), /loopback/);
});
test('proposal application is exact, allowlisted, sequential and never fuzzy', () => {
  const sources = [{ path: 'src/a.js', content: 'let busy = true;\n' }];
  const proposal = { summary: 'Reset busy', reasoning: 'Unblocks the next attempt', edits: [{ path: 'src/a.js', find: 'true', replace: 'false' }] };
  assert.equal(applyProposalToSources(proposal, sources).get('src/a.js'), 'let busy = false;\n');
  for (const edit of [{ path: 'src/b.js', find: 'true', replace: 'false' }, { path: 'src/a.js', find: 'missing', replace: 'false' }, { path: 'src/a.js', find: 'true', replace: 'true' }, { path: '../a.js', find: 'true', replace: 'false' }]) assert.throws(() => applyProposalToSources({ ...proposal, edits: [edit] }, sources));
  assert.throws(() => applyProposalToSources(proposal, [{ path: 'src/a.js', content: 'true true' }]), /exactly once/);
});
test('provider needs consent, credential and a model before any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Unexpected request'); };
  await assert.rejects(proposeRepair({}, { fetchImpl }), /source-upload/);
  await assert.rejects(proposeRepair({}, { allowSourceUpload: true, apiKey: '', model: 'test', fetchImpl }), /OPENAI_API_KEY/);
  await assert.rejects(proposeRepair({}, { allowSourceUpload: true, apiKey: 'test', fetchImpl }), /provider.model/);
  assert.equal(calls, 0);
  await assert.rejects(prepareRepair(config, '/tmp/unused-recovery-run'), /allow-execution/);
});
test('Responses adapter uses schema, no storage and handles refusal/incomplete/error safely', async () => {
  const proposal = { summary: 'test', reasoning: 'test', edits: [] };
  const options = { allowSourceUpload: true, apiKey: 'not-real', model: 'configured-by-user' };
  const result = await proposeRepair({ sources: [] }, { ...options, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body);
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    assert.equal(body.model, 'configured-by-user');
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }) };
  } });
  assert.deepEqual(result, proposal);
  for (const data of [{ status: 'incomplete' }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, { status: 'completed', output: [] }]) await assert.rejects(proposeRepair({}, { ...options, fetchImpl: async () => ({ ok: true, json: async () => data }) }));
  await assert.rejects(proposeRepair({}, { ...options, fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
});
test('command timeouts terminate children and provider secrets are not inherited', async () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-leak';
  try {
    assert.equal(executionEnvironment().OPENAI_API_KEY, undefined);
    const result = await runCommand([process.execPath, '-e', 'setInterval(()=>{}, 1000)'], process.cwd(), 100);
    assert.equal(result.timedOut, true);
    const missing = await runCommand(['recovery-probe-nonexistent-command'], process.cwd(), 1000);
    assert.ok(missing.error);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});
