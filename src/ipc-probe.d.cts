export interface ProbeWebContents {
  id: number; mainFrame: unknown; isDestroyed(): boolean; getURL(): string; executeJavaScript(code: string): Promise<unknown>;
}
export interface IpcSnapshot {
  id: string; channel: string; senderId: number; injected: number;
  startedAt: number; capturedAt: number; observation: boolean; observingUntil: number | null;
  injectedAt: number | null; successfulAfterFault: number;
  armed: { fault: 'rejection' | 'null-result'; remaining: number; expiresAt: number } | null;
  channels: Record<string, { calls: number; realCalls: number; successes: number; errors: number; pending: number; maxDurationMs: number; firstReadAt: number | null; lastReadAt: number | null; firstCompletedAt: number | null; lastCompletedAt: number | null; lastSuccessAt: number | null }>;
}
export interface IpcProbe {
  identify(): { version: string; runtime: { node: string; electron: string | null; chrome: string | null }; senderId: number; pageUrl: string; registered: string[]; capabilities: { maxFaultCount: number; observation: true; readTimestamps: true } };
  identify(challenge: string): Promise<{ version: string; runtime: { node: string; electron: string | null; chrome: string | null }; senderId: number; pageUrl: string; registered: string[]; capabilities: { maxFaultCount: number; observation: true; readTimestamps: true } }>;
  begin(options: { id: string; channel: string; requiredChannels?: string[]; times?: number; ttlMs?: number } & ({ observation: true; fault?: never } | { observation?: false; fault?: 'rejection' | 'null-result' })): IpcSnapshot;
  snapshot(): IpcSnapshot | null;
  windowState(): { minimized: boolean };
  setWindowMinimized(minimized: boolean): { minimized: boolean };
  reset(id?: string): IpcSnapshot | null;
  dispose(): void;
}
export function installIpcProbe(ipcMain: { handle(channel: string, listener: (...args: any[]) => any): void }, options: { enabled: boolean; channels: string[]; sender: () => ProbeWebContents | undefined | null }): IpcProbe;
