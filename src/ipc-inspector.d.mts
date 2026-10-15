import type { IpcProbe, IpcSnapshot } from './ipc-probe.cjs'
export interface IpcInspector {
  call(
    method: 'identify',
    challenge?: string,
  ): Promise<
    ReturnType<IpcProbe['identify']> extends Promise<infer T> ? T : never
  >
  call(
    method: 'begin',
    options: Parameters<IpcProbe['begin']>[0],
  ): Promise<IpcSnapshot>
  call(method: 'snapshot'): Promise<IpcSnapshot | null>
  call(method: 'reset', id?: string): Promise<IpcSnapshot | null>
  call(method: 'windowState'): Promise<{ minimized: boolean }>
  call(
    method: 'setWindowMinimized',
    minimized: boolean,
  ): Promise<{ minimized: boolean }>
  close(): void
}
export function connectIpcInspector(endpoint?: string): Promise<IpcInspector>
/** Advanced protocol transport; only the documented probe control methods are allowed. */
export function callIpcInspector(
  send: (method: string, params: Record<string, unknown>) => Promise<any>,
  method:
    | 'identify'
    | 'begin'
    | 'snapshot'
    | 'reset'
    | 'windowState'
    | 'setWindowMinimized',
  argument?: unknown,
): Promise<any>
