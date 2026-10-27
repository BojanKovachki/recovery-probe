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

const reply = (id: JsonRpcId, result: unknown) => ({
  jsonrpc: '2.0',
  id,
  result,
})

type Method = (id: JsonRpcId, params: Record<string, unknown>) => unknown

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
  return new McpServer(options, output).serve(input)
}

class McpServer {
  readonly #options: McpServerOptions
  readonly #output: Writable
  readonly #tools: Map<string, McpTool>
  readonly #running = new Map<JsonRpcId, AbortController>()
  readonly #methods = new Map<string, Method>([
    ['initialize', (id, params) => this.#initialize(id, params)],
    ['ping', (id) => reply(id, {})],
    [
      'tools/list',
      (id) =>
        reply(id, {
          tools: this.#options.tools.map(({ run: _run, ...tool }) => tool),
        }),
    ],
    ['tools/call', (id, params) => this.#callTool(id, params)],
  ])

  constructor(options: McpServerOptions, output: Writable) {
    this.#options = options
    this.#output = output
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  }

  serve(input: Readable): Promise<void> {
    return new Promise((resolve) => {
      const lines = createInterface({ input, crlfDelay: Infinity })
      const pending = new Set<Promise<void>>()
      lines.on('line', (line) => {
        const work = this.#receive(line)
        if (!work) return
        pending.add(work)
        void work.finally(() => pending.delete(work))
      })
      lines.on('close', () => {
        for (const controller of this.#running.values()) controller.abort()
        void Promise.allSettled([...pending]).then(() => resolve())
      })
    })
  }

  #send(message: unknown) {
    this.#output.write(`${JSON.stringify(message)}\n`)
  }

  /** Handles one line; requests run concurrently, and each reply carries its id. */
  #receive(line: string): Promise<void> | undefined {
    if (!line.trim()) return undefined
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#send(failure(null, -32700, 'Parse error'))
      return undefined
    }
    return (async () => {
      if (Array.isArray(message)) {
        const replies = (
          await Promise.all(message.map((item) => this.#handle(item)))
        ).filter((answer) => answer !== undefined)
        if (replies.length) this.#send(replies)
      } else {
        const answer = await this.#handle(message as JsonRpcMessage)
        if (answer !== undefined) this.#send(answer)
      }
    })()
  }

  async #handle(message: JsonRpcMessage): Promise<unknown> {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return failure(message?.id ?? null, -32600, 'Invalid request')
    const { id, method, params = {} } = message
    // Notifications get no reply.
    if (id === undefined || id === null) {
      if (method === 'notifications/cancelled')
        this.#running.get(params.requestId as JsonRpcId)?.abort()
      return undefined
    }
    const answer = this.#methods.get(method)
    return answer
      ? answer(id, params)
      : failure(id, -32601, `Method not found: ${method}`)
  }

  #initialize(id: JsonRpcId, params: Record<string, unknown>) {
    const requested = String(params.protocolVersion ?? '')
    const { name, version, instructions } = this.#options
    return reply(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name, version },
      ...(instructions ? { instructions } : {}),
    })
  }

  async #callTool(id: JsonRpcId, params: Record<string, unknown>) {
    const tool = this.#tools.get(String(params.name))
    if (!tool)
      return failure(id, -32602, `Unknown tool: ${String(params.name)}`)
    const controller = new AbortController()
    this.#running.set(id, controller)
    try {
      const result = await tool.run(
        (params.arguments ?? {}) as Record<string, unknown>,
        { signal: controller.signal },
      )
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      })
    } catch (error) {
      // A tool failure is a result the model can read and act on, not a protocol error.
      return reply(id, {
        content: [{ type: 'text', text: (error as Error).message }],
        isError: true,
      })
    } finally {
      this.#running.delete(id)
    }
  }
}
