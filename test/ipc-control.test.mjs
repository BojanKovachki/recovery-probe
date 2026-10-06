import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callIpcInspector } from '../src/ipc-inspector.mjs';
import { resetIpcAndConfirm } from '../src/ipc-control.mjs';

test('synchronous controls never enable implicit Promise awaiting', async () => {
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (params.awaitPromise !== false) throw Error('Promise was collected');
    return { result: { value: { armed: null } } };
  };
  for (const [method, argument] of [['identify'], ['snapshot'], ['begin', { id: 'run' }], ['reset', 'run']]) {
    assert.deepEqual(await callIpcInspector(send, method, argument), { armed: null });
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.method === 'Runtime.evaluate' && c.params.returnByValue === true));
});

test('async identification retains and explicitly awaits its Promise, then releases it', async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        assert.equal(params.awaitPromise, false); assert.equal(params.returnByValue, false);
        assert.match(params.objectGroup, /^recovery-probe-/);
        return { result: { subtype: 'promise', objectId: 'retained-promise' } };
      }
      if (method === 'Runtime.awaitPromise') {
        assert.equal(params.promiseObjectId, 'retained-promise');
        if (fail) throw Error('simulated protocol failure');
        return { result: { value: { senderId: 2 } } };
      }
      return {};
    };
    if (fail) await assert.rejects(callIpcInspector(send, 'identify', 'nonce'), /protocol failure/);
    else assert.deepEqual(await callIpcInspector(send, 'identify', 'nonce'), { senderId: 2 });
    assert.deepEqual(calls.map(c => c.method), ['Runtime.evaluate', 'Runtime.awaitPromise', 'Runtime.releaseObjectGroup']);
    assert.equal(calls[0].params.objectGroup, calls[2].params.objectGroup);
  }
});

test('readback verifies disarm despite lost reset replies; newer armed plans are not reset', async () => {
  let state = { id: 'run', armed: { fault: 'rejection' } };
  const calls = [];
  const control = { async call(method, id) {
    calls.push([method, id]);
    if (method === 'reset') {
      assert.equal(id, 'run');
      if (state.id !== id) throw Error('Stale run ID');
      state.armed = null;
      throw Error('reset reply lost');
    }
    return state;
  } };
  assert.equal((await resetIpcAndConfirm(control, 'run')).armed, null);
  assert.deepEqual(calls.map(c => c[0]), ['reset', 'snapshot']);
  state = { id: 'newer', armed: { fault: 'rejection' } };
  await assert.rejects(resetIpcAndConfirm(control, 'run'), /cleanup unverified/);
  assert.notEqual(state.armed, null);
  for (const snapshot of [undefined, {}, { armed: {} }]) {
    await assert.rejects(resetIpcAndConfirm({ call: async method => method === 'snapshot' ? snapshot : null }, 'run'), /cleanup unverified/);
  }
  await assert.rejects(resetIpcAndConfirm({ call: async () => { throw Error('disconnected'); } }, 'run'), /cannot read back state/);
});
