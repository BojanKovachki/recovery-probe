import { randomUUID } from 'node:crypto'
import type { IpcProbe, IpcSnapshot } from '../../ipc-probe.cjs'
import { debuggerUrl, InspectorSocket } from './socket.mjs'

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

type ProbeControl =
  | 'identify'
  | 'begin'
  | 'snapshot'
  | 'reset'
  | 'windowState'
  | 'setWindowMinimized'

type Send = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>

interface EvaluateResponse {
  exceptionDetails?: {
    exception?: { description?: string }
    text: string
  }
  result?: { subtype?: string; objectId?: string; value?: unknown }
}

const CONTROLS: readonly string[] = [
  'identify',
  'begin',
  'snapshot',
  'reset',
  'windowState',
  'setWindowMinimized',
]

export async function connectIpcInspector(
  endpoint = 'http://127.0.0.1:9229',
): Promise<IpcInspector> {
  const socket = await InspectorSocket.open(await debuggerUrl(endpoint))
  return {
    // One transport serves every overload; callIpcInspector validates the method.
    call: ((method: ProbeControl, argument?: unknown) =>
      callIpcInspector(socket.send, method, argument)) as IpcInspector['call'],
    close() {
      socket.close()
    },
  }
}

function checked(response: unknown) {
  const { exceptionDetails, result } = response as EvaluateResponse
  if (exceptionDetails)
    throw new Error(
      'IPC probe control failed: ' +
        (exceptionDetails.exception?.description ?? exceptionDetails.text),
    )
  return result
}

// Keep synchronous controls synchronous. Electron main-process inspector evaluation
// can lose the implicit promise created by awaitPromise:true even for plain values.
// Only identify(challenge) is async; retain its remote Promise before awaiting it.
/** Advanced protocol transport; only the documented probe control methods are allowed. */
export async function callIpcInspector(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  method: ProbeControl,
  argument?: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- public signature: the result is whatever the probe control returned.
): Promise<any> {
  if (!CONTROLS.includes(method)) throw new Error('Unsupported probe control')
  const expression = `globalThis.__recoveryProbeIpc.${method}(${argument === undefined ? '' : JSON.stringify(argument)})`
  return method === 'identify' && argument !== undefined
    ? evaluateAsync(send, expression)
    : evaluate(send, expression)
}

async function evaluate(send: Send, expression: string) {
  const result = checked(
    await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    }),
  )
  if (result?.subtype === 'promise')
    throw new Error('A synchronous IPC control unexpectedly returned a Promise')
  return result?.value
}

async function evaluateAsync(send: Send, expression: string) {
  const objectGroup = `recovery-probe-${randomUUID()}`
  try {
    const result = checked(
      await send('Runtime.evaluate', {
        expression,
        returnByValue: false,
        awaitPromise: false,
        objectGroup,
      }),
    )
    if (result?.subtype !== 'promise' || !result.objectId)
      throw new Error('Window identification did not return a Promise')
    return checked(
      await send('Runtime.awaitPromise', {
        promiseObjectId: result.objectId,
        returnByValue: true,
      }),
    )?.value
  } finally {
    // Closing the inspector also releases references if explicit release fails.
    await send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {})
  }
}
