'use strict';

const installed = new WeakSet();

// No Electron import: use its public registration API, supplied by the development app.
exports.installIpcProbe = function installIpcProbe(ipcMain, { channels, sender, enabled = false } = {}) {
  if (enabled !== true) throw new Error('IPC probe requires explicit development-only enablement');
  if (!Array.isArray(channels) || !channels.length || channels.some(c => typeof c !== 'string' || !c.trim()) || new Set(channels).size !== channels.length) throw new Error('Provide unique, explicitly allowed read channels');
  if (typeof sender !== 'function' || typeof ipcMain?.handle !== 'function') throw new Error('Provide ipcMain and a sender function returning the target WebContents');
  if (installed.has(ipcMain)) throw new Error('IPC probe already installed; restart the development app to reinstall');
  const allowed = new Set(channels);
  const registered = new Set();
  const original = ipcMain.handle;
  let active = true;
  let state = null;
  let timer;
  const seenIds = new Set();
  const identify = challenge => {
    const contents = sender();
    if (!contents || contents.isDestroyed()) throw new Error('Target WebContents is not available');
    const identity = { senderId: contents.id, pageUrl: contents.getURL(), registered: [...registered] };
    if (challenge === undefined) return identity;
    if (typeof challenge !== 'string' || !/^[a-f0-9-]{36}$/.test(challenge)) throw new Error('Invalid window challenge');
    return contents.executeJavaScript(`globalThis.__recoveryProbeWindowNonce === ${JSON.stringify(challenge)}`).then(matches => {
      if (!matches) throw new Error('CDP window does not match the main-process target');
      return identity;
    });
  };
  const matches = event => {
    const contents = sender();
    return contents && !contents.isDestroyed() && event?.sender === contents && contents.mainFrame && event.senderFrame === contents.mainFrame;
  };
  const disarm = () => { clearTimeout(timer); if (state) state.armed = null; };
  const snapshot = () => {
    if (state?.armed && Date.now() >= state.armed.expiresAt) disarm();
    return state ? JSON.parse(JSON.stringify(state)) : null;
  };
  const begin = ({ id, channel, requiredChannels = [], fault, ttlMs = 30000 } = {}) => {
    if (!active) throw new Error('IPC probe is disposed');
    if (typeof id !== 'string' || !id || id.length > 100 || seenIds.has(id)) throw new Error('Use a new non-empty run ID');
    if (seenIds.size >= 10000) throw new Error('Restart the dev app after 10000 probe runs');
    if (!Array.isArray(requiredChannels)) throw new Error('requiredChannels must be an array');
    const watched = [...new Set([channel, ...requiredChannels])];
    if (watched.some(c => !allowed.has(c) || !registered.has(c))) throw new Error('All watched channels must be allowed and registered after installing the probe');
    if (fault !== undefined && !['rejection', 'null-result'].includes(fault)) throw new Error('Supported IPC faults: rejection, null-result');
    if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 60000) throw new Error('ttlMs must be 100–60000');
    if (state && Object.values(state.channels).some(c => c.pending)) throw new Error('Previous real calls are still pending; wait before beginning another run');
    const identity = identify();
    disarm(); seenIds.add(id);
    state = { id, channel, senderId: identity.senderId, injected: 0, injectedAt: null, successfulAfterFault: 0, armed: fault ? { fault, expiresAt: Date.now() + ttlMs } : null, channels: Object.create(null) };
    for (const name of watched) state.channels[name] = { calls: 0, realCalls: 0, successes: 0, errors: 0, pending: 0, maxDurationMs: 0 };
    if (fault) { timer = setTimeout(disarm, ttlMs); timer.unref?.(); }
    return snapshot();
  };
  function handle(channel, real) {
    if (!allowed.has(channel)) return Reflect.apply(original, this, [channel, real]);
    if (typeof real !== 'function') return Reflect.apply(original, this, [channel, real]);
    function dispatch(event, ...args) {
      const current = state;
      const row = active && current && matches(event) && event.sender.id === current.senderId ? current.channels[channel] : null;
      if (!row) return Reflect.apply(real, this, [event, ...args]);
      row.calls++;
      if (current.armed && Date.now() >= current.armed.expiresAt) disarm();
      if (channel === current.channel && current.armed) {
        const fault = current.armed.fault;
        disarm(); current.injected++; current.injectedAt = Date.now();
        return fault === 'null-result' ? Promise.resolve(null) : Promise.reject(new Error('Recovery Probe: injected IPC rejection'));
      }
      row.realCalls++; row.pending++;
      const started = Date.now();
      const afterFault = current.injected === 1;
      const finish = success => {
        row.pending--; row.maxDurationMs = Math.max(row.maxDurationMs, Date.now() - started);
        if (success) { row.successes++; if (afterFault && channel === current.channel) current.successfulAfterFault++; }
        else row.errors++;
      };
      let result;
      try { result = Reflect.apply(real, this, [event, ...args]); }
      catch (error) { finish(false); throw error; }
      // Observe settlement without replacing the handler's original return value/Promise.
      Promise.resolve(result).then(() => finish(true), () => finish(false));
      return result;
    }
    const result = Reflect.apply(original, this, [channel, dispatch]);
    registered.add(channel);
    return result;
  }
  ipcMain.handle = handle;
  installed.add(ipcMain);
  return Object.freeze({
    identify, begin, snapshot,
    reset(id) {
      if (id !== undefined && state && id !== state.id) throw new Error('Stale run ID');
      disarm(); return snapshot();
    },
    dispose() {
      disarm(); active = false;
      if (ipcMain.handle === handle) ipcMain.handle = original;
      // Existing dispatchers remain transparent; no private maps or re-registration.
    },
  });
};
