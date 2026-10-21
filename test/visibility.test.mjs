import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareVisibility, windowVisibility } from '../dist/visibility.mjs'
function fixture(unsupported = false) {
  let state = 'minimized'
  const page = {
    evaluate: async () => (state === 'minimized' ? 'hidden' : 'visible'),
    context: () => ({
      newCDPSession: async () => ({
        send: async (method, args) => {
          if (unsupported) throw Error('unsupported')
          if (method === 'Target.getTargetInfo')
            return { targetInfo: { targetId: 'one' } }
          if (method === 'Browser.getWindowForTarget')
            return { windowId: 1, bounds: { windowState: state } }
          if (method === 'Browser.setWindowBounds')
            state = args.bounds.windowState
        },
        detach: async () => {},
      }),
    }),
  }
  const control = {
    call: async (method, arg) => {
      if (method === 'setWindowMinimized') state = arg ? 'minimized' : 'normal'
      return { minimized: state === 'minimized' }
    },
  }
  return { page, control, state: () => state }
}
test('unminimize is opt-in, reversible and supports an Electron control fallback', async () => {
  for (const unsupported of [false, true]) {
    const f = fixture(unsupported)
    const control = unsupported ? f.control : undefined
    assert.equal(
      (await windowVisibility(f.page, control)).windowState,
      'minimized',
    )
    const unchanged = await prepareVisibility(f.page, { control })
    assert.equal(f.state(), 'minimized')
    await unchanged.revert()
    const changed = await prepareVisibility(f.page, {
      control,
      restoreWindow: true,
    })
    assert.equal(f.state(), 'normal')
    await changed.revert()
    assert.equal(f.state(), 'minimized')
  }
})

test('tells a visible page that draws frames from one that does not', async () => {
  const page = (rendering) => ({
    evaluate: async (probe) =>
      String(probe).includes('requestAnimationFrame') ? rendering : 'visible',
    context: () => ({
      newCDPSession: async () => {
        throw Error('unsupported')
      },
    }),
  })
  assert.equal((await windowVisibility(page('frames'))).diagnosis, 'visible')
  const asleep = await windowVisibility(page('no-viewport'))
  assert.equal(asleep.rendering, 'no-viewport')
  assert.match(asleep.diagnosis, /^visible-without-viewport/)
  const behind = await windowVisibility(page('no-frames'))
  assert.equal(behind.visibility, 'visible')
  assert.match(behind.diagnosis, /^visible-not-rendering/)
  const announced = []
  await prepareVisibility(page('no-frames'), {
    announce: (message) => announced.push(message),
  })
  assert.match(announced[0], /draws no frames.*Clicks may time out/)
})
