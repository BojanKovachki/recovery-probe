import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { ServerWebSocket } from '../../dist/targets/cdp-bridge/websocket.mjs'

function peer(limit) {
  const frames = []
  const messages = []
  let closed = 0
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      frames.push(chunk)
      callback()
    },
  })
  new ServerWebSocket(
    socket,
    (text) => messages.push(text),
    () => closed++,
    limit,
  )
  return { socket, frames, messages, closed: () => closed }
}

function frame(opcode, text, fin = true) {
  const payload = Buffer.from(text)
  const mask = Buffer.from([1, 2, 3, 4])
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]),
    mask,
    Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4])),
  ])
}

test('bounds a fragmented message before receiving the oversized continuation payload', () => {
  const p = peer(8)
  p.socket.emit('data', frame(1, '12345', false))
  p.socket.emit('data', frame(0, '678', false))
  assert.equal(p.closed(), 0)
  // Only the next frame header is needed to reject the cumulative size.
  p.socket.emit('data', frame(0, '9').subarray(0, 2))
  assert.equal(p.closed(), 1)
  assert.equal(p.frames.at(-1).readUInt16BE(2), 1009)
  p.socket.emit('data', frame(1, 'late'))
  assert.deepEqual(p.messages, [])
})

test('accepts messages at the limit and resets the budget, including interleaved ping', () => {
  const p = peer(8)
  const bytes = Buffer.concat([
    frame(1, '12345', false),
    frame(9, 'ping'),
    frame(0, '', false),
    frame(0, '678'),
    frame(1, 'abcdefgh'),
  ])
  for (const byte of bytes) p.socket.emit('data', Buffer.from([byte]))
  assert.deepEqual(p.messages, ['12345678', 'abcdefgh'])
  assert.equal(p.closed(), 0)
  assert.equal(p.frames[0][0], 0x8a)
  p.socket.destroy()
})

test('rejects a single oversized frame using the production default without buffering its payload', () => {
  const p = peer(undefined)
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 0xff
  header.writeBigUInt64BE(BigInt(256 * 1024 * 1024 + 1), 2)
  p.socket.emit('data', header)
  assert.equal(p.closed(), 1)
  assert.equal(p.frames.at(-1).readUInt16BE(2), 1009)
  assert.deepEqual(p.messages, [])
})
