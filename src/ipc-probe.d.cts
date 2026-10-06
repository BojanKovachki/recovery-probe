export interface ProbeWebContents {
  id: number; mainFrame: unknown; isDestroyed(): boolean; getURL(): string; executeJavaScript(code: string): Promise<unknown>;
}
export interface IpcSnapshot {
  id: string; channel: string; senderId: number; injected: number;
  injectedAt: number | null; successfulAfterFault: number;
  armed: { fault: 'rejection' | 'null-result'; expiresAt: number } | null;
  channels: Record<string, { calls: number; realCalls: number; successes: number; errors: number; pending: number; maxDurationMs: number }>;
}
export interface IpcProbe {
  identify(): { senderId: number; pageUrl: string; registered: string[] };
  identify(challenge: string): Promise<{ senderId: number; pageUrl: string; registered: string[] }>;
  begin(options: { id: string; channel: string; requiredChannels?: string[]; fault?: 'rejection' | 'null-result'; ttlMs?: number }): IpcSnapshot;
  snapshot(): IpcSnapshot | null;
  reset(id?: string): IpcSnapshot | null;
  dispose(): void;
}
export function installIpcProbe(ipcMain: { handle(channel: string, listener: (...args: any[]) => any): void }, options: { enabled: boolean; channels: string[]; sender: () => ProbeWebContents | undefined | null }): IpcProbe;
