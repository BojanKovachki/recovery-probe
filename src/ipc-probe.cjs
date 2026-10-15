'use strict'
const { version } = require('../package.json')

const installed = new WeakSet()
const MAX_LABELS = 200
// Labels are developer-chosen method names, never argument values.
const label = (value) =>
  typeof value === 'string' && /^[\w.:/-]{1,100}$/.test(value) ? value : null
const readStats = () => ({
  calls: 0,
  successes: 0,
  errors: 0,
  pending: 0,
  firstReadAt: null,
  lastReadAt: null,
  firstCompletedAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
})

// No Electron import: use its public registration API, supplied by the development app.
exports.installIpcProbe = function installIpcProbe(
  ipcMain,
  {
    channels,
    sender,
    enabled = false,
    classify,
    pushChannels = [],
    classifyPush,
  } = {},
) {
  if (enabled !== true)
    throw new Error('IPC probe requires explicit development-only enablement')
  if (
    !Array.isArray(channels) ||
    !channels.length ||
    channels.some((c) => typeof c !== 'string' || !c.trim()) ||
    new Set(channels).size !== channels.length
  )
    throw new Error('Provide unique, explicitly allowed read channels')
  if (typeof sender !== 'function' || typeof ipcMain?.handle !== 'function')
    throw new Error(
      'Provide ipcMain and a sender function returning the target WebContents',
    )
  if (classify !== undefined && typeof classify !== 'function')
    throw new Error('classify must be a function returning a method label')
  if (classifyPush !== undefined && typeof classifyPush !== 'function')
    throw new Error('classifyPush must be a function returning an event label')
  if (
    !Array.isArray(pushChannels) ||
    pushChannels.some((c) => typeof c !== 'string' || !c.trim()) ||
    new Set(pushChannels).size !== pushChannels.length
  )
    throw new Error('pushChannels must be unique channel names')
  if (installed.has(ipcMain))
    throw new Error(
      'IPC probe already installed; restart the development app to reinstall',
    )
  const allowed = new Set(channels)
  const allowedPushes = new Set(pushChannels)
  const registered = new Set()
  const original = ipcMain.handle
  let active = true
  let state = null
  let timer
  let wrappedSend = null
  const seenIds = new Set()
  const capabilities = () => ({
    maxFaultCount: 10,
    observation: true,
    readTimestamps: true,
    methods: Boolean(classify),
    pushes: allowedPushes.size > 0,
  })
  const identify = (challenge) => {
    const contents = sender()
    if (!contents || contents.isDestroyed())
      throw new Error('Target WebContents is not available')
    const identity = {
      version,
      runtime: {
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
      },
      senderId: contents.id,
      pageUrl: contents.getURL(),
      registered: [...registered],
      pushChannels: [...allowedPushes],
      capabilities: capabilities(),
    }
    if (challenge === undefined) return identity
    if (typeof challenge !== 'string' || !/^[a-f0-9-]{36}$/.test(challenge))
      throw new Error('Invalid window challenge')
    return contents
      .executeJavaScript(
        `globalThis.__recoveryProbeWindowNonce === ${JSON.stringify(challenge)}`,
      )
      .then((matches) => {
        if (!matches)
          throw new Error('CDP window does not match the main-process target')
        return identity
      })
  }
  const matches = (event) => {
    const contents = sender()
    return (
      contents &&
      !contents.isDestroyed() &&
      event?.sender === contents &&
      contents.mainFrame &&
      event.senderFrame === contents.mainFrame
    )
  }
  // A classifier failure or an unexpected label must never affect the real call.
  const classifyCall = (fn, channel, args, table) => {
    if (!fn) return null
    let name
    try {
      name = label(fn(channel, args)) ?? 'unclassified'
    } catch {
      name = 'unclassified'
    }
    return table[name] || Object.keys(table).length < MAX_LABELS
      ? name
      : '(other)'
  }
  const unwrapSend = () => {
    if (!wrappedSend) return
    const { contents, wrapper } = wrappedSend
    // Only remove our own instance property; the prototype method stays untouched.
    if (
      !contents.isDestroyed?.() &&
      Object.hasOwn(contents, 'send') &&
      contents.send === wrapper
    )
      delete contents.send
    wrappedSend = null
  }
  const wrapSend = (contents, current) => {
    if (!allowedPushes.size || typeof contents?.send !== 'function') return
    const send = contents.send
    const wrapper = function (channel, ...args) {
      if (
        state === current &&
        current.observingUntil &&
        Date.now() < current.observingUntil &&
        allowedPushes.has(channel)
      ) {
        const at = Date.now()
        const row = current.pushes[channel]
        row.count++
        row.firstAt ??= at
        row.lastAt = at
        const name = classifyCall(classifyPush, channel, args, row.methods)
        if (name) {
          const m = (row.methods[name] ??= {
            count: 0,
            firstAt: null,
            lastAt: null,
          })
          m.count++
          m.firstAt ??= at
          m.lastAt = at
        }
      }
      return Reflect.apply(send, this, [channel, ...args])
    }
    Object.defineProperty(contents, 'send', {
      value: wrapper,
      configurable: true,
      writable: true,
    })
    wrappedSend = { contents, wrapper }
  }
  const disarm = () => {
    clearTimeout(timer)
    unwrapSend()
    if (state) {
      state.armed = null
      state.observingUntil = null
    }
  }
  const snapshot = () => {
    if (
      (state?.armed && Date.now() >= state.armed.expiresAt) ||
      (state?.observingUntil && Date.now() >= state.observingUntil)
    )
      disarm()
    return state
      ? JSON.parse(JSON.stringify({ ...state, capturedAt: Date.now() }))
      : null
  }
  const begin = ({
    id,
    channel,
    requiredChannels = [],
    fault,
    observation = false,
    times = 1,
    ttlMs = 30000,
  } = {}) => {
    if (!active) throw new Error('IPC probe is disposed')
    if (typeof id !== 'string' || !id || id.length > 100 || seenIds.has(id))
      throw new Error('Use a new non-empty run ID')
    if (seenIds.size >= 10000)
      throw new Error('Restart the dev app after 10000 probe runs')
    if (!Array.isArray(requiredChannels))
      throw new Error('requiredChannels must be an array')
    const watched = [...new Set([channel, ...requiredChannels])]
    if (watched.some((c) => !allowed.has(c) || !registered.has(c)))
      throw new Error(
        'All watched channels must be allowed and registered after installing the probe',
      )
    if (fault !== undefined && !['rejection', 'null-result'].includes(fault))
      throw new Error('Supported IPC faults: rejection, null-result')
    if (
      typeof observation !== 'boolean' ||
      (observation && fault !== undefined)
    )
      throw new Error('Observation must be fault-free')
    if (!Number.isInteger(times) || times < 1 || times > 10)
      throw new Error('times must be 1–10')
    if (
      !Number.isInteger(ttlMs) ||
      ttlMs < 100 ||
      ttlMs > (observation ? 125000 : 60000)
    )
      throw new Error('ttlMs exceeds the supported bounds')
    snapshot() // Expire a previous lease before the atomic ownership check.
    if (state?.observingUntil || (observation && state?.armed))
      throw new Error('IPC_PLAN_ALREADY_ACTIVE')
    if (state && Object.values(state.channels).some((c) => c.pending))
      throw new Error(
        'Previous real calls are still pending; wait before beginning another run',
      )
    const identity = identify()
    disarm()
    seenIds.add(id)
    state = {
      id,
      channel,
      senderId: identity.senderId,
      startedAt: Date.now(),
      observation,
      observingUntil: observation ? Date.now() + ttlMs : null,
      injected: 0,
      injectedAt: null,
      successfulAfterFault: 0,
      armed: fault
        ? { fault, remaining: times, expiresAt: Date.now() + ttlMs }
        : null,
      channels: Object.create(null),
      pushes: Object.create(null),
    }
    for (const name of watched)
      state.channels[name] = {
        ...readStats(),
        realCalls: 0,
        maxDurationMs: 0,
        ...(classify ? { methods: Object.create(null) } : {}),
      }
    // Pushes are observation evidence only; they are never counted during fault plans.
    if (observation) {
      for (const name of allowedPushes)
        state.pushes[name] = {
          count: 0,
          firstAt: null,
          lastAt: null,
          methods: Object.create(null),
        }
      wrapSend(sender(), state)
    }
    if (fault || observation) {
      timer = setTimeout(disarm, ttlMs)
      timer.unref?.()
    }
    return snapshot()
  }
  function handle(channel, real) {
    if (!allowed.has(channel))
      return Reflect.apply(original, this, [channel, real])
    if (typeof real !== 'function')
      return Reflect.apply(original, this, [channel, real])
    function dispatch(event, ...args) {
      if (state?.observingUntil && Date.now() >= state.observingUntil) disarm()
      const current = state
      const row =
        active &&
        current &&
        (!current.observation || current.observingUntil) &&
        matches(event) &&
        event.sender.id === current.senderId
          ? current.channels[channel]
          : null
      if (!row) return Reflect.apply(real, this, [event, ...args])
      row.calls++
      row.firstReadAt ??= Date.now()
      row.lastReadAt = Date.now()
      const name = row.methods
        ? classifyCall(classify, channel, args, row.methods)
        : null
      const method = name ? (row.methods[name] ??= readStats()) : null
      if (method) {
        method.calls++
        method.firstReadAt ??= row.lastReadAt
        method.lastReadAt = row.lastReadAt
      }
      if (current.armed && Date.now() >= current.armed.expiresAt) disarm()
      if (channel === current.channel && current.armed) {
        const fault = current.armed.fault
        current.armed.remaining--
        if (!current.armed.remaining) disarm()
        current.injected++
        current.injectedAt ??= Date.now()
        return fault === 'null-result'
          ? Promise.resolve(null)
          : Promise.reject(new Error('Recovery Probe: injected IPC rejection'))
      }
      row.realCalls++
      row.pending++
      if (method) method.pending++
      const started = Date.now()
      const afterFault = current.injected > 0
      const finish = (success) => {
        const completed = Date.now()
        for (const stats of method ? [row, method] : [row]) {
          stats.firstCompletedAt ??= completed
          stats.lastCompletedAt = completed
          if (success) {
            stats.lastSuccessAt = completed
            stats.successes++
          } else stats.errors++
          stats.pending--
        }
        row.maxDurationMs = Math.max(row.maxDurationMs, Date.now() - started)
        if (success && afterFault && channel === current.channel)
          current.successfulAfterFault++
      }
      let result
      try {
        result = Reflect.apply(real, this, [event, ...args])
      } catch (error) {
        finish(false)
        throw error
      }
      // Observe settlement without replacing the handler's original return value/Promise.
      Promise.resolve(result).then(
        () => finish(true),
        () => finish(false),
      )
      return result
    }
    const result = Reflect.apply(original, this, [channel, dispatch])
    registered.add(channel)
    return result
  }
  ipcMain.handle = handle
  installed.add(ipcMain)
  return Object.freeze({
    identify,
    begin,
    snapshot,
    windowState() {
      const window = sender()?.getOwnerBrowserWindow?.()
      if (!window || window.isDestroyed())
        throw new Error('Window control unavailable')
      return { minimized: window.isMinimized() }
    },
    setWindowMinimized(minimized) {
      if (typeof minimized !== 'boolean')
        throw new Error('Expected boolean window state')
      const window = sender()?.getOwnerBrowserWindow?.()
      if (!window || window.isDestroyed())
        throw new Error('Window control unavailable')
      if (minimized) window.minimize()
      else window.restore()
      return { minimized: window.isMinimized() }
    },
    reset(id) {
      if (id !== undefined && state && id !== state.id)
        throw new Error('Stale run ID')
      disarm()
      return snapshot()
    },
    dispose() {
      disarm()
      active = false
      if (ipcMain.handle === handle) ipcMain.handle = original
      // Existing dispatchers remain transparent; no private maps or re-registration.
    },
  })
}
