import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationConfig, ipcObservationAdapter } from '../src/observe.mjs';
import { installIpcProbe } from '../src/ipc-probe.cjs';

function fixture() {
  let listener, complete;
  const ipc = { handle(channel, fn) { listener = fn; } };
  const sender = { id: 1, mainFrame: {}, isDestroyed: () => false, getURL: () => 'file:///synthetic.html' };
  const probe = installIpcProbe(ipc, { enabled: true, channels: ['fixture:read'], sender: () => sender });
  ipc.handle('fixture:read', () => new Promise(resolve => { complete = resolve; }));
  const control = { call: async (method, arg) => probe[method](arg) };
  return { probe, control, call: () => listener({ sender, senderFrame: sender.mainFrame }), complete: () => complete('value') };
}
const c = { channel: 'fixture:read', observationMs: 500 };
test('observation config rejects mutation options and requires explicit content evidence', () => {
  const input = { transport: 'http', endpoint: 'http://localhost/api/items', regionSelector: '#items', contentSelector: 'li' };
  assert.equal(observationConfig(input).observationMs, 30000);
  for (const extra of [{ reload: true }, { fault: 'rejection' }, { observationMs: 0 }, { contentSelector: '' }, { endpoint: 'http://localhost/api/items?token=secret' }, { cdp: 'http://remote.example:9222' }]) assert.throws(() => observationConfig({ ...input, ...extra }));
});
test('fault-free IPC observation tracks starts and settlements, preserves promises, and stops without clearing UI state', async () => {
  const f = fixture();
  const a = ipcObservationAdapter(f.control, c, 1);
  await a.start();
  const pending = f.call();
  const started = await a.snapshot();
  assert.equal(started.channels[c.channel].pending, 1);
  assert.ok(started.channels[c.channel].firstReadAt >= started.startedAt);
  assert.equal(started.channels[c.channel].lastCompletedAt, null);
  assert.throws(() => f.probe.begin({ id: 'foreign', channel: c.channel, fault: 'rejection' }), /ALREADY_ACTIVE/);
  f.complete(); await pending;
  const ended = await a.snapshot();
  assert.equal(ended.channels[c.channel].successes, 1);
  assert.ok(ended.channels[c.channel].lastCompletedAt >= ended.channels[c.channel].lastReadAt);
  await a.stop();
  assert.equal(f.probe.snapshot().observingUntil, null);
  const unobserved = f.call(); f.complete(); await unobserved;
  assert.equal(f.probe.snapshot().channels[c.channel].calls, 1);
});
test('lost observation begin reply is cleaned up; foreign fault and observation plans are never replaced', async () => {
  const f = fixture();
  const unreliable = { async call(method, arg) { const value = await f.control.call(method, arg); if (method === 'begin') throw Error('lost reply'); return value; } };
  const a = ipcObservationAdapter(unreliable, c, 1);
  await assert.rejects(a.start(), /lost reply/); await a.stop();
  assert.equal(f.probe.snapshot().observingUntil, null);
  for (const plan of [{ fault: 'rejection' }, { observation: true }]) {
    const id = JSON.stringify(plan);
    f.probe.begin({ id, channel: c.channel, ...plan });
    const foreign = ipcObservationAdapter(f.control, c, 1);
    await assert.rejects(foreign.start(), /ALREADY_ACTIVE/);
    await foreign.stop();
    assert.equal(f.probe.snapshot().id, id);
    assert.ok(f.probe.snapshot().armed || f.probe.snapshot().observingUntil);
    // Atomic check also protects against a plan started between preflight and begin.
    assert.throws(() => f.probe.begin({ id: 'racing-' + id, channel: c.channel, observation: true }), /ALREADY_ACTIVE/);
    f.probe.reset(id);
  }
});
test('observation rejects faults and expires its lease; unsupported hooks fail before mutation', async () => {
  const f = fixture();
  assert.throws(() => f.probe.begin({ id: 'bad', channel: c.channel, observation: true, fault: 'rejection' }), /fault-free/);
  f.probe.begin({ id: 'expire', channel: c.channel, observation: true, ttlMs: 100 });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.probe.snapshot().observingUntil, null);
  const calls = [];
  const old = ipcObservationAdapter({ async call(method) { calls.push(method); return { senderId: 1, capabilities: {} }; } }, c, 1);
  await assert.rejects(old.start(), /UNSUPPORTED/); await old.stop();
  assert.deepEqual(calls, ['identify']);
});
