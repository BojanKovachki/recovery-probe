// eslint-disable-next-line @typescript-eslint/no-require-imports -- package.json is outside the source root, so it is read at runtime.
const { version } = require('../package.json') as { version: string }

export interface ProbeWebContents {
  id: number
  mainFrame: unknown
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(code: string): Promise<unknown>
  send?(channel: string, ...args: unknown[]): void
  /** Used for the opt-in window minimize/restore controls. */
  getOwnerBrowserWindow?(): {
    isDestroyed(): boolean
    isMinimized(): boolean
    minimize(): void
    restore(): void
  } | null
}
export interface IpcReadStats {
  calls: number
  successes: number
  errors: number
  pending: number
  firstReadAt: number | null
  lastReadAt: number | null
  firstCompletedAt: number | null
  lastCompletedAt: number | null
  lastSuccessAt: number | null
}
export interface IpcPushStats {
  count: number
  firstAt: number | null
  lastAt: number | null
}
export interface IpcSnapshot {
  id: string
  channel: string
  senderId: number
  injected: number
  startedAt: number
  capturedAt: number
  observation: boolean
  observingUntil: number | null
  injectedAt: number | null
  successfulAfterFault: number
  armed: {
    fault: 'rejection' | 'null-result'
    remaining: number
    expiresAt: number
  } | null
  channels: Record<
    string,
    IpcReadStats & {
      realCalls: number
      maxDurationMs: number
      methods?: Record<string, IpcReadStats>
    }
  >
  /** Present for observation plans when push channels are configured. Counts and times only; no payloads. */
  pushes: Record<
    string,
    IpcPushStats & { methods: Record<string, IpcPushStats> }
  >
}
export interface IpcIdentity {
  version: string
  runtime: { node: string; electron: string | null; chrome: string | null }
  senderId: number
  pageUrl: string
  registered: string[]
  pushChannels: string[]
  capabilities: {
    maxFaultCount: number
    observation: true
    readTimestamps: true
    methods: boolean
    pushes: boolean
  }
}
export interface IpcProbe {
  identify(): IpcIdentity
  identify(challenge: string): Promise<IpcIdentity>
  begin(
    options: {
      id: string
      channel: string
      requiredChannels?: string[]
      times?: number
      ttlMs?: number
    } & (
      | { observation: true; fault?: never }
      | { observation?: false; fault?: 'rejection' | 'null-result' }
    ),
  ): IpcSnapshot
  snapshot(): IpcSnapshot | null
  windowState(): { minimized: boolean }
  setWindowMinimized(minimized: boolean): { minimized: boolean }
  reset(id?: string): IpcSnapshot | null
  dispose(): void
}

type ProbeState = Omit<IpcSnapshot, 'capturedAt'>
type Classifier = (
  channel: string,
  args: unknown[],
) => string | null | undefined
interface InvokeEvent {
  sender?: ProbeWebContents
  senderFrame?: unknown
}

const installed = new WeakSet<object>()
const MAX_LABELS = 200
// Labels are developer-chosen method names, never argument values.
const label = (value: unknown) =>
  typeof value === 'string' && /^[\w.:/-]{1,100}$/.test(value) ? value : null
const readStats = (): IpcReadStats => ({
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
export function installIpcProbe(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron's listener takes and returns untyped IPC values.
  ipcMain: { handle(channel: string, listener: (...args: any[]) => any): void },
  options: {
    enabled: boolean
    channels: string[]
    sender: () => ProbeWebContents | undefined | null
    /** Development-only: returns a method label (/^[\w.:/-]{1,100}$/) for a call. Arguments are never stored. */
    classify?: Classifier
    /** Main-to-renderer channels whose sends to the target window are counted during observation. */
    pushChannels?: string[]
    /** Development-only: returns an event label for a push. Payloads are never stored. */
    classifyPush?: Classifier
  },
): IpcProbe {
  const {
    channels,
    sender,
    enabled = false,
    classify,
    pushChannels = [],
    classifyPush,
  }: Partial<typeof options> = options === undefined ? {} : options
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
  const registered = new Set<string>()
  const original = ipcMain.handle
  let active = true
  let state: ProbeState | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let wrappedSend: {
    contents: ProbeWebContents
    wrapper: NonNullable<ProbeWebContents['send']>
    previous: PropertyDescriptor | undefined
  } | null = null
  const seenIds = new Set<string>()
  const capabilities = () => ({
    maxFaultCount: 10,
    observation: true as const,
    readTimestamps: true as const,
    methods: Boolean(classify),
    pushes: allowedPushes.size > 0,
  })
  const identify = ((
    challenge?: unknown,
  ): IpcIdentity | Promise<IpcIdentity> => {
    const contents = sender()
    if (!contents || contents.isDestroyed())
      throw new Error('Target WebContents is not available')
    const identity: IpcIdentity = {
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
  }) as { (): IpcIdentity; (challenge: unknown): Promise<IpcIdentity> }
  const matches = (event: InvokeEvent | undefined) => {
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
  const classifyCall = (
    fn: Classifier | undefined,
    channel: string,
    args: unknown[],
    table: Record<string, unknown>,
  ) => {
    if (!fn) return null
    let name: string
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
    const { contents, wrapper, previous } = wrappedSend
    // Undo only our own change: restore an instance-level send that existed before the
    // lease (for example an app's tracing wrapper), or remove ours to expose the prototype
    // method again. A wrapper installed after ours stays; ours then only passes calls through.
    if (
      !contents.isDestroyed?.() &&
      Object.hasOwn(contents, 'send') &&
      contents.send === wrapper
    ) {
      if (previous) Object.defineProperty(contents, 'send', previous)
      else delete contents.send
    }
    wrappedSend = null
  }
  const wrapSend = (
    contents: ProbeWebContents | undefined | null,
    current: ProbeState,
  ) => {
    if (!allowedPushes.size || typeof contents?.send !== 'function') return
    const previous = Object.getOwnPropertyDescriptor(contents, 'send')
    const send = contents.send
    const wrapper = function (
      this: unknown,
      channel: string,
      ...args: unknown[]
    ) {
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
    wrappedSend = { contents, wrapper, previous }
  }
  const disarm = () => {
    clearTimeout(timer)
    unwrapSend()
    if (state) {
      state.armed = null
      state.observingUntil = null
    }
  }
  const snapshot = (): IpcSnapshot | null => {
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
  }: Record<string, unknown> = {}): IpcSnapshot => {
    if (!active) throw new Error('IPC probe is disposed')
    if (typeof id !== 'string' || !id || id.length > 100 || seenIds.has(id))
      throw new Error('Use a new non-empty run ID')
    if (seenIds.size >= 10000)
      throw new Error('Restart the dev app after 10000 probe runs')
    if (!Array.isArray(requiredChannels))
      throw new Error('requiredChannels must be an array')
    const watched = [...new Set([channel, ...requiredChannels])] as string[]
    if (watched.some((c) => !allowed.has(c) || !registered.has(c)))
      throw new Error(
        'All watched channels must be allowed and registered after installing the probe',
      )
    if (
      fault !== undefined &&
      !['rejection', 'null-result'].includes(fault as string)
    )
      throw new Error('Supported IPC faults: rejection, null-result')
    if (
      typeof observation !== 'boolean' ||
      (observation && fault !== undefined)
    )
      throw new Error('Observation must be fault-free')
    if (
      typeof times !== 'number' ||
      !Number.isInteger(times) ||
      times < 1 ||
      times > 10
    )
      throw new Error('times must be 1–10')
    if (
      typeof ttlMs !== 'number' ||
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
      channel: channel as string,
      senderId: identity.senderId,
      startedAt: Date.now(),
      observation,
      observingUntil: observation ? Date.now() + ttlMs : null,
      injected: 0,
      injectedAt: null,
      successfulAfterFault: 0,
      armed: fault
        ? {
            fault: fault as 'rejection' | 'null-result',
            remaining: times,
            expiresAt: Date.now() + ttlMs,
          }
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
    return snapshot()!
  }
  function handle(this: unknown, channel: string, real: unknown) {
    if (!allowed.has(channel))
      return Reflect.apply(original, this, [channel, real])
    if (typeof real !== 'function')
      return Reflect.apply(original, this, [channel, real])
    const dispatch = function (
      this: unknown,
      event: InvokeEvent,
      ...args: unknown[]
    ) {
      if (state?.observingUntil && Date.now() >= state.observingUntil) disarm()
      const current = state
      const row =
        active &&
        current &&
        (!current.observation || current.observingUntil) &&
        matches(event) &&
        event.sender!.id === current.senderId
          ? current.channels[channel]
          : null
      if (!current || !row) return Reflect.apply(real, this, [event, ...args])
      row.calls++
      row.firstReadAt ??= Date.now()
      row.lastReadAt = Date.now()
      const name = row.methods
        ? classifyCall(classify, channel, args, row.methods)
        : null
      const method = name ? (row.methods![name] ??= readStats()) : null
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
      const finish = (success: boolean) => {
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
      let result: unknown
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
    setWindowMinimized(minimized: boolean) {
      if (typeof minimized !== 'boolean')
        throw new Error('Expected boolean window state')
      const window = sender()?.getOwnerBrowserWindow?.()
      if (!window || window.isDestroyed())
        throw new Error('Window control unavailable')
      if (minimized) window.minimize()
      else window.restore()
      return { minimized: window.isMinimized() }
    },
    reset(id?: string) {
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
