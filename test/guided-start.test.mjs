import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choose, parseStartArgs, runStart } from '../src/guided-start.mjs';

test('guided CLI rejects ambiguous options and unsafe URLs before opening an app', async () => {
  assert.deepEqual(parseStartArgs(['web', 'http://localhost:3000', '--fresh']), { target: 'web', url: 'http://localhost:3000', fresh: true });
  assert.deepEqual(parseStartArgs(['desktop', '--cdp', 'http://127.0.0.1:9333']), { target: 'desktop', cdp: 'http://127.0.0.1:9333' });
  for (const args of [[], ['web', '--cdp', 'x'], ['desktop', '--headless'], ['web', '--dir'], ['web', '--unknown']]) assert.throws(() => parseStartArgs(args));
  const dir = await mkdtemp(join(tmpdir(), 'guided-unit-'));
  const io = { interactive: true, log() {}, ask() { throw new Error('Unexpected question'); } };
  try {
    await assert.rejects(runStart({ target: 'web', url: 'file:///private', dir }, io), /HTTP/);
    await assert.rejects(runStart({ target: 'web', url: 'http://user:secret@localhost', dir }, io), /credentials/);
    await assert.rejects(runStart({ target: 'web', url: 'http://localhost', dir, headless: true }, io), /visible browser/);
    await assert.rejects(runStart({ target: 'desktop', dir }, { ...io, interactive: false }), /interactive terminal/);
    await writeFile(join(dir, 'setup.json'), JSON.stringify({ schemaVersion: 1, target: 'web', requestedUrl: 'http://localhost/one' }));
    await assert.rejects(runStart({ target: 'web', url: 'http://localhost/two', dir }, io), /another URL/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('single window is selected without input; ambiguous choices require valid selection', async () => {
  const logs = [];
  const answers = ['0', 'oops', '2'];
  const io = { log: value => logs.push(value), ask: async () => answers.shift() };
  assert.equal(await choose(io, 'Window', [{ label: 'Single', value: 7 }]), 7);
  assert.equal(answers.length, 3);
  assert.equal(await choose(io, 'Window', [{ label: 'One\x1b[0m', value: 1 }, { label: 'Two', value: 2 }]), 2);
  assert.ok(logs.every(line => !line.includes('\x1b')));
  await assert.rejects(choose(io, 'Window', []), /No choices/);
});
