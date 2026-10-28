import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 256 * 1024 * 1024

export interface WebSocketPeer {
  send(text: string): void
  close(): void
}

interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** A final frame's header for `length` bytes of payload (RFC 6455, section 5.2). */
function frameHeader(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length])
  if (length < 65536)
    return Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
  const header = Buffer.alloc(10)
  header[0] = 0x80 | opcode
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return header
}

/** The payload length and where the mask or payload starts, once enough has arrived. */
function payloadLength(buffered: Buffer) {
  const length = buffered[1] & 0x7f
  if (length === 126)
    return buffered.length < 4
      ? undefined
      : { length: buffered.readUInt16BE(2), offset: 4 }
  if (length === 127)
    return buffered.length < 10
      ? undefined
      : { length: Number(buffered.readBigUInt64BE(2)), offset: 10 }
  return { length, offset: 2 }
}

/** The first whole frame and its size in bytes, or undefined until it has all arrived. */
function readFrame(
  buffered: Buffer,
  remaining: number,
): { frame: Frame; size: number } | 'too-large' | undefined {
  if (buffered.length < 2) return undefined
  const header = payloadLength(buffered)
  if (!header) return undefined
  const opcode = buffered[0] & 0x0f
  const limit = opcode < 0x8 ? remaining : 125
  if (header.length > limit) return 'too-large'
  const masked = (buffered[1] & 0x80) !== 0
  const start = header.offset + (masked ? 4 : 0)
  const end = start + header.length
  if (buffered.length < end) return undefined
  const payload = Buffer.from(buffered.subarray(start, end))
  if (masked)
    for (let i = 0; i < payload.length; i++)
      payload[i] ^= buffered[header.offset + (i % 4)]
  const fin = (buffered[0] & 0x80) !== 0
  return { frame: { fin, opcode: buffered[0] & 0x0f, payload }, size: end }
}

/** Accepts a WebSocket upgrade (RFC 6455) and delivers its text messages. */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  onMessage: (text: string) => void,
  onClose: () => void,
): WebSocketPeer {
  const key = request.headers['sec-websocket-key']
  const accept = createHash('sha1')
    .update(`${key}${ACCEPT_GUID}`)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  return new ServerWebSocket(socket, onMessage, onClose)
}

export class ServerWebSocket implements WebSocketPeer {
  readonly #socket: Duplex
  readonly #onMessage: (text: string) => void
  readonly #onClose: () => void
  readonly #maxMessage: number
  #closed = false
  #buffered = Buffer.alloc(0)
  #message: Buffer[] = []
  #messageBytes = 0

  constructor(
    socket: Duplex,
    onMessage: (text: string) => void,
    onClose: () => void,
    maxMessage = MAX_MESSAGE,
  ) {
    this.#socket = socket
    this.#onMessage = onMessage
    this.#onClose = onClose
    this.#maxMessage = maxMessage
    socket.on('data', (chunk: Buffer) => this.#receive(chunk))
    socket.on('close', () => {
      if (this.#closed) return
      this.#closed = true
      this.#clear()
      this.#onClose()
    })
    socket.on('error', () => socket.destroy())
  }

  readonly send = (text: string) => {
    if (!this.#closed) this.#frame(0x1, Buffer.from(text))
  }

  readonly close = (code = 1000) => {
    if (this.#closed) return
    this.#closed = true
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code)
    this.#frame(0x8, payload)
    this.#clear()
    this.#socket.end()
    this.#onClose()
  }

  #frame(opcode: number, payload: Buffer) {
    this.#socket.write(
      Buffer.concat([frameHeader(opcode, payload.length), payload]),
    )
  }

  #receive(chunk: Buffer) {
    if (this.#closed) return
    this.#buffered = Buffer.concat([this.#buffered, chunk])
    while (!this.#closed) {
      const read = readFrame(
        this.#buffered,
        this.#maxMessage - this.#messageBytes,
      )
      if (read === undefined) return
      if (read === 'too-large') return this.close(1009)
      this.#buffered = this.#buffered.subarray(read.size)
      if (read.frame.opcode === 0x8) return this.close()
      this.#handle(read.frame)
    }
  }

  #clear() {
    this.#buffered = Buffer.alloc(0)
    this.#message = []
    this.#messageBytes = 0
  }

  #handle({ fin, opcode, payload }: Frame) {
    if (opcode === 0x9) this.#frame(0xa, payload)
    else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (payload.length) this.#message.push(payload)
      this.#messageBytes += payload.length
      if (fin) {
        const text = Buffer.concat(this.#message).toString('utf8')
        this.#message = []
        this.#messageBytes = 0
        this.#onMessage(text)
      }
    }
  }
}
