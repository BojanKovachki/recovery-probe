import type { Page } from 'playwright'
import { boundedUiRead } from '../ui-read.mjs'
import {
  installBridgeCounter,
  readBridgeCounter,
  removeBridgeCounter,
  type BridgeCounts,
} from './bridge.mjs'
import type { SlowReadsConfig } from './config.mjs'
import { RendererLoad, type RendererTime } from './renderer-load.mjs'

/** What the slow-read probe measures with each sample. */
export interface LoadSample {
  renderer: RendererTime | null
  bridge: BridgeCounts | null
}

export interface ProbeStatus {
  renderer: { measured: boolean; error?: string }
  bridge: { global: string; installed: boolean; reason?: string } | null
}

/** Measures the renderer's main-thread time and, when configured, a page bridge's queue. */
export class SlowReadProbe {
  readonly #page: Page
  readonly #config: SlowReadsConfig
  readonly #token: string
  readonly #renderer = new RendererLoad()
  #bridge: ProbeStatus['bridge'] = null

  constructor(page: Page, config: SlowReadsConfig, token: string) {
    this.#page = page
    this.#config = config
    this.#token = token
  }

  get status(): ProbeStatus {
    return { renderer: this.#renderer.status, bridge: this.#bridge }
  }

  async start() {
    await this.#renderer.start(this.#page)
    const bridge = this.#config.bridge
    if (!bridge) return
    const token = this.#token
    try {
      const result = await boundedUiRead(
        () => this.#page.evaluate(installBridgeCounter, { token, bridge }),
        undefined,
      )
      this.#bridge = { global: bridge.global, ...result }
    } catch (error) {
      this.#bridge = {
        global: bridge.global,
        installed: false,
        reason: String((error as Error).message).split('\n')[0],
      }
    }
  }

  async read(): Promise<LoadSample> {
    const [renderer, bridge] = await Promise.all([
      this.#renderer.read(),
      this.#bridge?.installed
        ? this.#page.evaluate(readBridgeCounter, this.#token).catch(() => null)
        : null,
    ])
    return { renderer, bridge }
  }

  async stop() {
    await this.#renderer.stop()
    if (!this.#bridge?.installed) return
    const token = this.#token
    // Bounded: an unresponsive document must not hold up the rest of the cleanup.
    await boundedUiRead(
      () => this.#page.evaluate(removeBridgeCounter, token),
      undefined,
      1000,
    ).catch(() => {})
  }
}
