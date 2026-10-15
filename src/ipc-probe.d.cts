export interface ProbeWebContents {
  id: number
  mainFrame: unknown
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(code: string): Promise<unknown>
  send?(channel: string, ...args: unknown[]): void
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
export function installIpcProbe(
  ipcMain: { handle(channel: string, listener: (...args: any[]) => any): void },
  options: {
    enabled: boolean
    channels: string[]
    sender: () => ProbeWebContents | undefined | null
    /** Development-only: returns a method label (/^[\w.:/-]{1,100}$/) for a call. Arguments are never stored. */
    classify?: (channel: string, args: unknown[]) => string | null | undefined
    /** Main-to-renderer channels whose sends to the target window are counted during observation. */
    pushChannels?: string[]
    /** Development-only: returns an event label for a push. Payloads are never stored. */
    classifyPush?: (
      channel: string,
      args: unknown[],
    ) => string | null | undefined
  },
): IpcProbe
