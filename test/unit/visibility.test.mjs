import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  prepareVisibility,
  windowVisibility,
} from '../../dist/targets/visibility.mjs'
import { fake } from '../helpers/fake.mjs'
/** @typedef {import('playwright').Page} Page */

function fixture(unsupported = false) {
  let state = 'minimized'
  /** @type {Page} */
  const page = fake({
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
  })
  /** @type {Parameters<typeof windowVisibility>[1]} */
  const control = fake({
    call: async (method, arg) => {
      if (method === 'setWindowMinimized') state = arg ? 'minimized' : 'normal'
      return { minimized: state === 'minimized' }
    },
  })
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

/** A hidden, uncovered-but-not-minimized page whose CDP window calls fail. */
const hiddenPage = () =>
  fake({
    evaluate: async () => 'hidden',
    context: () => ({
      newCDPSession: async () => {
        throw Error('unsupported')
      },
    }),
  })

test('keeps a hidden window drawing for the run and puts its throttling back', async () => {
  let throttled = true
  /** @type {Parameters<typeof prepareVisibility>[1]['control']} */
  const control = fake({
    call: async (method, arg) => {
      if (method === 'windowState') return { minimized: false }
      const previous = throttled
      throttled = arg
      return { allowed: arg, previous }
    },
  })
  const messages = []
  const prepared = await prepareVisibility(hiddenPage(), {
    control,
    keepRendering: true,
    announce: (message) => messages.push(message),
  })
  assert.equal(throttled, false)
  assert.match(prepared.initial.diagnosis, /^hidden-not-minimized/)
  assert.deepEqual(messages, [
    'Recovery Probe: keeping the target window drawing frames while it is minimized or covered; its background throttling is restored afterwards.',
  ])
  await prepared.revert()
  assert.equal(throttled, true)
})

test('warns about a hidden page, and needs the IPC hook to keep it drawing', async () => {
  const messages = []
  await prepareVisibility(hiddenPage(), {
    announce: (message) => messages.push(message),
  })
  assert.match(messages[0], /^Recovery Probe: hidden: .*Clicks may time out/)
  await assert.rejects(
    prepareVisibility(hiddenPage(), { keepRendering: true, announce() {} }),
    /keepRendering needs the IPC development hook/,
  )
})

test('says what is wrong with the window on stderr, so JSON on stdout stays parseable', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  const logs = t.mock.method(console, 'log', () => {})
  await prepareVisibility(hiddenPage())
  assert.equal(logs.mock.callCount(), 0)
  assert.match(
    String(errors.mock.calls[0].arguments[0]),
    /^Recovery Probe: hidden/,
  )
})

test('says when the background throttling was not put back, or the app runs an older hook', async () => {
  /** @param {(method: string) => unknown} reply */
  const controlWith = (reply) =>
    /** @type {Parameters<typeof prepareVisibility>[1]['control']} */ (
      fake({
        call: async (method) =>
          method === 'windowState' ? { minimized: false } : reply(method),
      })
    )
  const stuck = await prepareVisibility(hiddenPage(), {
    control: controlWith(() => ({ allowed: false, previous: true })),
    keepRendering: true,
    announce() {},
  })
  await assert.rejects(stuck.revert(), /restoration unverified/)
  await assert.rejects(
    prepareVisibility(hiddenPage(), {
      control: controlWith(() => {
        throw new Error('setBackgroundThrottling is not a function')
      }),
      keepRendering: true,
      announce() {},
    }),
    /restart the app so it loads it/,
  )
})

test('tells a visible page that draws frames from one that does not', async () => {
  /** @returns {Page} */
  const page = (rendering) =>
    fake({
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
