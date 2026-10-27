import type { CDPSession, Page } from 'playwright'

/** How long the page's main thread has run tasks and script, in ms since it started. */
export interface RendererTime {
  taskMs: number
  scriptMs: number
}

/**
 * Reads Chrome's Performance metrics for the page. Task time counts every task on the
 * main thread, so a thread kept busy by many short tasks shows up, not only long tasks.
 */
export class RendererLoad {
  #session: CDPSession | undefined
  #error: string | undefined

  async start(page: Page) {
    try {
      const session = await page.context().newCDPSession(page)
      await session.send('Performance.enable')
      this.#session = session
    } catch (error) {
      this.#error = String((error as Error).message).split('\n')[0]
    }
  }

  get status() {
    return this.#error === undefined
      ? { measured: true }
      : { measured: false, error: this.#error }
  }

  async read(): Promise<RendererTime | null> {
    if (!this.#session) return null
    try {
      const { metrics } = await this.#session.send('Performance.getMetrics')
      const value = (name: string) =>
        metrics.find((metric) => metric.name === name)?.value
      const task = value('TaskDuration')
      if (task === undefined) return null
      return {
        taskMs: task * 1000,
        scriptMs: (value('ScriptDuration') ?? 0) * 1000,
      }
    } catch {
      return null
    }
  }

  async stop() {
    const session = this.#session
    this.#session = undefined
    await session?.send('Performance.disable').catch(() => {})
    await session?.detach().catch(() => {})
  }
}
