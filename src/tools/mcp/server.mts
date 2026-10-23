import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

/** A tool an MCP client can call. `run` resolves with the result or throws a message for the agent. */
export interface McpTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  run(
    args: Record<string, unknown>,
    context: { signal: AbortSignal },
  ): Promise<unknown>
}

export interface McpServerOptions {
  name: string
  version: string
  /** Guidance clients may show to the model. */
  instructions?: string
  tools: McpTool[]
}

type JsonRpcId = string | number
interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId | null
  method?: string
  params?: Record<string, unknown>
}

// Newest first: a client asking for one of these gets it, any other gets the newest.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const failure = (id: JsonRpcId | null, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

/**
 * Serves tools over MCP's stdio transport: newline-delimited JSON-RPC on the input
 * and output streams. Only the protocol may write to the output; log to stderr.
 * Resolves when the input ends.
 */
export function serveMcp(
  options: McpServerOptions,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  const running = new Map<JsonRpcId, AbortController>()
  const send = (message: unknown) =>
    output.write(`${JSON.stringify(message)}\n`)

  const callTool = async (id: JsonRpcId, params: Record<string, unknown>) => {
    const tool = tools.get(String(params.name))
    if (!tool)
      return failure(id, -32602, `Unknown tool: ${String(params.name)}`)
    const controller = new AbortController()
    running.set(id, controller)
    try {
      const result = await tool.run(
        (params.arguments ?? {}) as Record<string, unknown>,
        { signal: controller.signal },
      )
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        },
      }
    } catch (error) {
      // A tool failure is a result the model can read and act on, not a protocol error.
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: (error as Error).message }],
          isError: true,
        },
      }
    } finally {
      running.delete(id)
    }
  }

  const handle = async (message: JsonRpcMessage): Promise<unknown> => {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return failure(message?.id ?? null, -32600, 'Invalid request')
    const { id, method, params = {} } = message
    // Notifications get no reply.
    if (id === undefined || id === null) {
      if (method === 'notifications/cancelled')
        running.get(params.requestId as JsonRpcId)?.abort()
      return undefined
    }
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '')
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name, version: options.version },
            ...(options.instructions
              ? { instructions: options.instructions }
              : {}),
          },
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: options.tools.map(({ run: _run, ...tool }) => tool),
          },
        }
      case 'tools/call':
        return callTool(id, params)
      default:
        return failure(id, -32601, `Method not found: ${method}`)
    }
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity })
    const pending = new Set<Promise<void>>()
    lines.on('line', (line) => {
      if (!line.trim()) return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        send(failure(null, -32700, 'Parse error'))
        return
      }
      // Requests run concurrently; each reply carries its id.
      const work = (async () => {
        if (Array.isArray(message)) {
          const replies = (await Promise.all(message.map(handle))).filter(
            (reply) => reply !== undefined,
          )
          if (replies.length) send(replies)
        } else {
          const reply = await handle(message as JsonRpcMessage)
          if (reply !== undefined) send(reply)
        }
      })()
      pending.add(work)
      void work.finally(() => pending.delete(work))
    })
    lines.on('close', () => {
      for (const controller of running.values()) controller.abort()
      void Promise.allSettled([...pending]).then(() => resolve())
    })
  })
}
