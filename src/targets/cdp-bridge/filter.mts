/** What CDP reports about a target, as far as the bridge needs it. */
export interface CdpTargetInfo {
  targetId: string
  type: string
  url: string
}

/** The fields of a CDP message the filter reads. */
interface CdpMessage {
  id?: number
  method?: string
  sessionId?: string
  params?: {
    targetInfo?: CdpTargetInfo
    targetId?: string
    sessionId?: string
    waitingForDebugger?: boolean
  }
  result?: { targetInfos?: CdpTargetInfo[] }
}

// Ids for the bridge's own commands, far above any a client uses.
export const BRIDGE_ID_BASE = 2 ** 31

/**
 * One client's view of the device: the targets `hide` picks, and their sessions, are
 * left out. Each target is decided once, when first seen: hiding one the client
 * already knows would leave it waiting for events that never come.
 */
export class TargetFilter {
  readonly #hide: (target: CdpTargetInfo) => boolean
  readonly #resume: (sessionId: string | undefined) => void
  readonly #hiddenTargets = new Set<string | undefined>()
  readonly #shownTargets = new Set<string>()
  readonly #hiddenSessions = new Set<string | undefined>()

  /** `resume` lets a hidden page that waits for a debugger run. */
  constructor(
    hide: (target: CdpTargetInfo) => boolean,
    resume: (sessionId: string | undefined) => void,
  ) {
    this.#hide = hide
    this.#resume = resume
  }

  /** The text to pass on to the client for one device message, or undefined to drop it. */
  forward(text: string): string | undefined {
    const message: CdpMessage = JSON.parse(text)
    if (message.sessionId && this.#hiddenSessions.has(message.sessionId))
      return undefined
    if ((message.id ?? 0) >= BRIDGE_ID_BASE) return undefined
    if (this.#dropsEvent(message)) return undefined
    const targetInfos = message.result?.targetInfos
    if (!Array.isArray(targetInfos)) return text
    message.result!.targetInfos = targetInfos.filter(
      (target) => !this.#isHidden(target),
    )
    return JSON.stringify(message)
  }

  #isHidden(target: CdpTargetInfo) {
    if (this.#shownTargets.has(target.targetId)) return false
    if (this.#hiddenTargets.has(target.targetId)) return true
    if (this.#hide(target)) this.#hiddenTargets.add(target.targetId)
    else this.#shownTargets.add(target.targetId)
    return this.#hiddenTargets.has(target.targetId)
  }

  /** Whether an event is about a hidden target or session. */
  #dropsEvent(message: CdpMessage): boolean {
    const { method } = message
    const params = message.params ?? {}
    const hidden = params.targetInfo ? this.#isHidden(params.targetInfo) : false
    if (method === 'Target.attachedToTarget')
      return hidden && this.#hideSession(params)
    if (TARGET_EVENTS.has(method)) return hidden
    if (GONE_EVENTS.has(method))
      return (
        this.#hiddenTargets.has(params.targetId) ||
        this.#hiddenSessions.has(params.sessionId)
      )
    return false
  }

  #hideSession({
    sessionId,
    waitingForDebugger,
  }: NonNullable<CdpMessage['params']>) {
    this.#hiddenSessions.add(sessionId)
    // Left paused, the page would never start.
    if (waitingForDebugger) this.#resume(sessionId)
    return true
  }
}

const TARGET_EVENTS: ReadonlySet<unknown> = new Set([
  'Target.targetCreated',
  'Target.targetInfoChanged',
])
const GONE_EVENTS: ReadonlySet<unknown> = new Set([
  'Target.targetDestroyed',
  'Target.targetCrashed',
  'Target.detachedFromTarget',
])
