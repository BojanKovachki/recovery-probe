import type { Browser, Page } from 'playwright'
import type { IpcIdentity } from '../ipc-probe.cjs'
import { confirmSameWindow } from '../transports/ipc/control.mjs'
import type { IpcInspector } from '../transports/ipc/inspector.mjs'
import { desktopPages } from './cdp.mjs'

/**
 * Finds the window the IPC hook watches, after checking that the hook captured
 * `channels`, and proves the debugging port and the hook reach that same window.
 */
export async function attachIpcWindow(
  browser: Browser,
  control: IpcInspector,
  channels: string[],
): Promise<{ page: Page; identity: IpcIdentity }> {
  const identity = await control.call('identify')
  for (const channel of channels)
    if (!identity.registered.includes(channel))
      throw new Error(
        `The hook didn't capture ${channel}: list it in the hook's channels, and load the hook before the app registers its handlers`,
      )
  const pages = desktopPages(browser).filter(
    (page) => page.url() === identity.pageUrl,
  )
  if (pages.length !== 1)
    throw new Error(
      'Keep exactly one window open on the screen the hook watches',
    )
  await confirmSameWindow(pages[0], control)
  return { page: pages[0], identity }
}
