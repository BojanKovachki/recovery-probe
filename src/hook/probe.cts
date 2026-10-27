import { injectedResult, trackCall } from './calls.cjs'
import {
  checkInstall,
  checkPlan,
  withPlanDefaults,
  type InstallOptions,
} from './checks.cjs'
import { PushCounter } from './pushes.cjs'
import { addPushRows, identityOf, newState } from './state.cjs'
import { classifyCall, readStats } from './stats.cjs'
import type {
  InvokeEvent,
  IpcIdentity,
  IpcProbe,
  IpcReadStats,
  IpcSnapshot,
  ProbeState,
  ProbeWebContents,
} from './types.cjs'

type Classifier = (
  channel: string,
  args: unknown[],
) => string | null | undefined
type IpcMain = Parameters<typeof installIpcProbe>[0]
type Handler = (...args: unknown[]) => unknown

const installed = new WeakSet<object>()

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
  const settings = checkInstall(ipcMain, options)
  if (installed.has(ipcMain))
    throw new Error(
      'IPC probe already installed; restart the development app to reinstall',
    )
  const probe = new ProbeHook(ipcMain, settings)
  installed.add(ipcMain)
  return probe.controls()
}

/** The installed hook: one plan at a time, counting and faulting the allowed channels. */
class ProbeHook {
  readonly #ipcMain: IpcMain
  readonly #original: IpcMain['handle']
  readonly #handle: IpcMain['handle']
  readonly #sender: InstallOptions['sender']
  readonly #classify: InstallOptions['classify']
  readonly #allowed: Set<string>
  readonly #allowedPushes: Set<string>
  readonly #registered = new Set<string>()
  readonly #seenIds = new Set<string>()
  readonly #pushes: PushCounter
  #active = true
  #state: ProbeState | null = null
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(ipcMain: IpcMain, settings: InstallOptions) {
    this.#ipcMain = ipcMain
    this.#original = ipcMain.handle
    this.#sender = settings.sender
    this.#classify = settings.classify
    this.#allowed = new Set(settings.channels)
    this.#allowedPushes = new Set(settings.pushChannels)
    this.#pushes = new PushCounter(
      this.#allowedPushes,
      settings.classifyPush,
      (state) => this.#state === state,
    )
    this.#handle = this.#interceptor()
    ipcMain.handle = this.#handle
  }

  /** Plain functions over the hook, so the app can pass them around. */
  controls(): IpcProbe {
    const controls: IpcProbe = {
      identify: ((challenge?: unknown) =>
        this.identify(challenge)) as IpcProbe['identify'],
      begin: (options) => this.begin(options),
      snapshot: () => this.snapshot(),
      windowState: () => this.windowState(),
      setWindowMinimized: (minimized) => this.setWindowMinimized(minimized),
      reset: (id) => this.reset(id),
      dispose: () => this.dispose(),
    }
    return Object.freeze(controls)
  }

  identify(challenge?: unknown): IpcIdentity | Promise<IpcIdentity> {
    const contents = this.#sender()
    if (!contents || contents.isDestroyed())
      throw new Error('Target WebContents is not available')
    const identity = identityOf(contents, {
      allowed: this.#allowed,
      registered: this.#registered,
      pushChannels: this.#allowedPushes,
      methods: Boolean(this.#classify),
    })
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

  begin(input: object = {}): IpcSnapshot {
    const requested = withPlanDefaults(input as Record<string, unknown>)
    if (!this.#active) throw new Error('IPC probe is disposed')
    const plan = checkPlan(requested, {
      seenIds: this.#seenIds,
      allowed: this.#allowed,
      registered: this.#registered,
    })
    this.#ensureFree(plan.observation)
    const identity = this.identify() as IpcIdentity
    this.#disarm()
    this.#seenIds.add(plan.id)
    const state = newState(plan, identity.senderId, Boolean(this.#classify))
    this.#state = state
    // Pushes are observation evidence only; they are never counted during fault plans.
    if (plan.observation) {
      addPushRows(state, this.#allowedPushes)
      this.#pushes.wrap(this.#sender(), state)
    }
    if (plan.fault || plan.observation) {
      this.#timer = setTimeout(() => this.#disarm(), plan.ttlMs)
      this.#timer.unref?.()
    }
    return this.snapshot()!
  }

  snapshot(): IpcSnapshot | null {
    const state = this.#state
    if (
      (state?.armed && Date.now() >= state.armed.expiresAt) ||
      (state?.observingUntil && Date.now() >= state.observingUntil)
    )
      this.#disarm()
    return state
      ? JSON.parse(JSON.stringify({ ...state, capturedAt: Date.now() }))
      : null
  }

  windowState() {
    return { minimized: this.#window().isMinimized() }
  }

  setWindowMinimized(minimized: boolean) {
    if (typeof minimized !== 'boolean')
      throw new Error('Expected boolean window state')
    const window = this.#window()
    if (minimized) window.minimize()
    else window.restore()
    return { minimized: window.isMinimized() }
  }

  reset(id?: string) {
    if (id !== undefined && this.#state && id !== this.#state.id)
      throw new Error('Stale run ID')
    this.#disarm()
    return this.snapshot()
  }

  dispose() {
    this.#disarm()
    this.#active = false
    if (this.#ipcMain.handle === this.#handle)
      this.#ipcMain.handle = this.#original
    // Existing dispatchers remain transparent; no private maps or re-registration.
  }

  /** Throws unless the hook is free for a new plan; an expired plan is let go first. */
  #ensureFree(observation: boolean) {
    this.snapshot() // Expire a previous lease before the atomic ownership check.
    const previous = this.#state
    if (previous?.observingUntil || (observation && previous?.armed))
      throw new Error('IPC_PLAN_ALREADY_ACTIVE')
    if (previous && Object.values(previous.channels).some((c) => c.pending))
      throw new Error(
        'Previous real calls are still pending; wait before beginning another run',
      )
  }

  #window() {
    const window = this.#sender()?.getOwnerBrowserWindow?.()
    if (!window || window.isDestroyed())
      throw new Error('Window control unavailable')
    return window
  }

  #disarm() {
    clearTimeout(this.#timer)
    this.#pushes.unwrap()
    if (this.#state) {
      this.#state.armed = null
      this.#state.observingUntil = null
    }
  }

  /** The replacement for ipcMain.handle: wraps the allowed channels' handlers. */
  #interceptor(): IpcMain['handle'] {
    const original = this.#original
    const allowed = this.#allowed
    const registered = this.#registered
    const wrap = (channel: string, real: Handler) => this.#wrap(channel, real)
    return function handle(this: unknown, channel: string, real: unknown) {
      if (!allowed.has(channel) || typeof real !== 'function')
        return Reflect.apply(original, this, [channel, real])
      const result = Reflect.apply(original, this, [
        channel,
        wrap(channel, real as Handler),
      ])
      registered.add(channel)
      return result
    }
  }

  #wrap(channel: string, real: Handler) {
    const call = (event: InvokeEvent, args: unknown[], invoke: () => unknown) =>
      this.#call(channel, event, args, invoke)
    return function dispatch(
      this: unknown,
      event: InvokeEvent,
      ...args: unknown[]
    ) {
      return call(event, args, () =>
        Reflect.apply(real, this, [event, ...args]),
      )
    }
  }

  /** One call on an allowed channel: counted and maybe faulted while a plan watches it. */
  #call(
    channel: string,
    event: InvokeEvent,
    args: unknown[],
    invoke: () => unknown,
  ) {
    const expiring = this.#state
    if (expiring?.observingUntil && Date.now() >= expiring.observingUntil)
      this.#disarm()
    const current = this.#state
    const row =
      current && this.#watches(current, event)
        ? current.channels[channel]
        : null
    if (!current || !row) return invoke()
    const method = this.#countCall(row, channel, args)
    return (
      this.#fault(current, channel) ??
      trackCall(current, channel, { row, method }, invoke)
    )
  }

  /** Whether the current plan counts a call: from the target window's main frame. */
  #watches(current: ProbeState, event: InvokeEvent) {
    return (
      this.#active &&
      (!current.observation || current.observingUntil) &&
      this.#fromTarget(event) &&
      event.sender!.id === current.senderId
    )
  }

  #fromTarget(event: InvokeEvent | undefined) {
    const contents = this.#sender()
    return (
      contents &&
      !contents.isDestroyed() &&
      event?.sender === contents &&
      contents.mainFrame &&
      event.senderFrame === contents.mainFrame
    )
  }

  #countCall(
    row: ProbeState['channels'][string],
    channel: string,
    args: unknown[],
  ): IpcReadStats | null {
    row.calls++
    row.firstReadAt ??= Date.now()
    row.lastReadAt = Date.now()
    const name = row.methods
      ? classifyCall(this.#classify, channel, args, row.methods)
      : null
    const method = name ? (row.methods![name] ??= readStats()) : null
    if (method) {
      method.calls++
      method.firstReadAt ??= row.lastReadAt
      method.lastReadAt = row.lastReadAt
    }
    return method
  }

  /** The injected result when the plan faults this call, or undefined to let it through. */
  #fault(current: ProbeState, channel: string) {
    if (current.armed && Date.now() >= current.armed.expiresAt) this.#disarm()
    const armed = current.armed
    if (channel !== current.channel || !armed) return undefined
    if (armed.skip) {
      armed.skip--
      return undefined
    }
    const { fault, delayMs } = armed
    armed.remaining--
    if (!armed.remaining) this.#disarm()
    current.injected++
    current.injectedAt ??= Date.now()
    return injectedResult(fault, delayMs)
  }
}
