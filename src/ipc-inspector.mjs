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
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector command timed out')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  return {
    async call(method, argument) {
      if (!['identify', 'begin', 'snapshot', 'reset'].includes(method)) throw new Error('Unsupported probe control');
      const response = await evaluate(`globalThis.__recoveryProbeIpc.${method}(${argument === undefined ? '' : JSON.stringify(argument)})`);
      if (response.exceptionDetails) throw new Error('IPC probe control failed: ' + (response.exceptionDetails.exception?.description ?? response.exceptionDetails.text));
      return response.result?.value;
    },
    close() { socket.close(); },
  };
}
