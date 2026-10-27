import type { LabelFunction } from './checks.cjs'
import { classifyCall } from './stats.cjs'
import type { ProbeState, ProbeWebContents } from './types.cjs'

type Send = NonNullable<ProbeWebContents['send']>

/** Counts the target window's sends on the push channels while a plan observes. */
export class PushCounter {
  readonly #channels: Set<string>
  readonly #classify: LabelFunction | undefined
  readonly #isCurrent: (state: ProbeState) => boolean
  #wrapped: {
    contents: ProbeWebContents
    wrapper: Send
    previous: PropertyDescriptor | undefined
  } | null = null

  /** `isCurrent` says whether a plan's state is still the hook's. */
  constructor(
    channels: Set<string>,
    classify: LabelFunction | undefined,
    isCurrent: (state: ProbeState) => boolean,
  ) {
    this.#channels = channels
    this.#classify = classify
    this.#isCurrent = isCurrent
  }

  wrap(contents: ProbeWebContents | undefined | null, current: ProbeState) {
    if (!this.#channels.size || typeof contents?.send !== 'function') return
    const previous = Object.getOwnPropertyDescriptor(contents, 'send')
    const send = contents.send
    const count = (channel: string, args: unknown[]) =>
      this.#count(current, channel, args)
    const wrapper = function (
      this: unknown,
      channel: string,
      ...args: unknown[]
    ) {
      count(channel, args)
      return Reflect.apply(send, this, [channel, ...args])
    }
    Object.defineProperty(contents, 'send', {
      value: wrapper,
      configurable: true,
      writable: true,
    })
    this.#wrapped = { contents, wrapper, previous }
  }

  unwrap() {
    if (!this.#wrapped) return
    const { contents, wrapper, previous } = this.#wrapped
    // Undo only our own change: restore an instance-level send that existed before the
    // lease (for example an app's tracing wrapper), or remove ours to expose the prototype
    // method again. A wrapper installed after ours stays; ours then only passes calls through.
    if (
      !contents.isDestroyed?.() &&
      Object.hasOwn(contents, 'send') &&
      contents.send === wrapper
    ) {
      if (previous) Object.defineProperty(contents, 'send', previous)
      else delete contents.send
    }
    this.#wrapped = null
  }

  #count(current: ProbeState, channel: string, args: unknown[]) {
    if (
      !this.#isCurrent(current) ||
      !current.observingUntil ||
      Date.now() >= current.observingUntil ||
      !this.#channels.has(channel)
    )
      return
    const at = Date.now()
    const row = current.pushes[channel]
    row.count++
    row.firstAt ??= at
    row.lastAt = at
    const name = classifyCall(this.#classify, channel, args, row.methods)
    if (!name) return
    const method = (row.methods[name] ??= {
      count: 0,
      firstAt: null,
      lastAt: null,
    })
    method.count++
    method.firstAt ??= at
    method.lastAt = at
  }
}
