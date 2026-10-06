import { randomUUID } from 'node:crypto';

/** Only the developer's explicitly selected loopback Node inspector is supported. */
function loopback(raw, protocols) {
  const url = new URL(raw);
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Inspector must use a loopback address without credentials');
  return url;
}
export async function connectIpcInspector(endpoint = 'http://127.0.0.1:9229') {
  let url = loopback(endpoint, ['http:', 'ws:']);
  if (url.protocol === 'http:') {
    const response = await fetch(new URL('/json/list', url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Inspector discovery returned HTTP ${response.status}`);
    const targets = (await response.json()).filter(item => item.type === 'node' && item.webSocketDebuggerUrl);
    if (targets.length !== 1) throw new Error('Expected exactly one Node inspector target on this port');
    const discovered = loopback(targets[0].webSocketDebuggerUrl, ['ws:']);
    if (discovered.port !== url.port) throw new Error('Inspector discovery changed ports');
    url = discovered;
  }
  const socket = new WebSocket(url);
  const pending = new Map();
  let next = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Inspector disconnected')); }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection timed out')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to Node inspector')); }, { once: true });
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Inspector is not connected')); return; }
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector command timed out')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  return {
    call: (method, argument) => callIpcInspector(send, method, argument),
    close() { socket.close(); },
  };
}

function checked(response) {
  if (response.exceptionDetails) throw new Error('IPC probe control failed: ' + (response.exceptionDetails.exception?.description ?? response.exceptionDetails.text));
  return response.result;
}

/** Keep synchronous controls synchronous. Electron main-process inspector evaluation
 * can lose the implicit promise created by awaitPromise:true even for plain values.
 * Only identify(challenge) is async; retain its remote Promise before awaiting it.
 */
export async function callIpcInspector(send, method, argument) {
  if (!['identify', 'begin', 'snapshot', 'reset'].includes(method)) throw new Error('Unsupported probe control');
  const expression = `globalThis.__recoveryProbeIpc.${method}(${argument === undefined ? '' : JSON.stringify(argument)})`;
  if (method !== 'identify' || argument === undefined) {
    const result = checked(await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }));
    if (result?.subtype === 'promise') throw new Error('A synchronous IPC control unexpectedly returned a Promise');
    return result?.value;
  }
  const objectGroup = `recovery-probe-${randomUUID()}`;
  try {
    const result = checked(await send('Runtime.evaluate', { expression, returnByValue: false, awaitPromise: false, objectGroup }));
    if (result?.subtype !== 'promise' || !result.objectId) throw new Error('Window identification did not return a Promise');
    return checked(await send('Runtime.awaitPromise', { promiseObjectId: result.objectId, returnByValue: true }))?.value;
  } finally {
    // Closing the inspector also releases references if explicit release fails.
    await send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
}
