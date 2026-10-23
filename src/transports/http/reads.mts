import type { Page, Request } from 'playwright'
import { pageIdentity } from '../../core/urls.mjs'

export function isReadRequest(request: Request, page: Page, endpoint?: string) {
  if (
    request.method() !== 'GET' ||
    !['fetch', 'xhr'].includes(request.resourceType())
  )
    return false
  try {
    return (
      request.frame() === page.mainFrame() &&
      (!endpoint || pageIdentity(request.url()) === endpoint)
    )
  } catch {
    return false
  }
}
