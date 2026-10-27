// The hook's public types. The hook runs inside the app's main process, so these
// files are CommonJS and import nothing outside src/hook.

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
    /** Calls on the channel that still pass through before the first fault. */
    skip: number
    expiresAt: number
    /** Injected results settle after this many milliseconds, like a slow request. */
    delayMs: number
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
  /** The channels the hook may fault. Older hooks leave it out. */
  channels?: string[]
  registered: string[]
  pushChannels: string[]
  capabilities: {
    maxFaultCount: number
    observation: true
    readTimestamps: true
    methods: boolean
    pushes: boolean
    faultDelay: true
    faultSkip: true
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
      | { observation: true; fault?: never; delayMs?: never }
      | {
          observation?: false
          fault?: 'rejection' | 'null-result'
          delayMs?: number
          /** Let this many calls through before the first fault: 1 fails the 2nd call. */
          skip?: number
        }
    ),
  ): IpcSnapshot
  snapshot(): IpcSnapshot | null
  windowState(): { minimized: boolean }
  setWindowMinimized(minimized: boolean): { minimized: boolean }
  reset(id?: string): IpcSnapshot | null
  dispose(): void
}

export type ProbeState = Omit<IpcSnapshot, 'capturedAt'>

export interface InvokeEvent {
  sender?: ProbeWebContents
  senderFrame?: unknown
}
