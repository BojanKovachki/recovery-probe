/**
 * A page's address for a report, without credentials or query values. Hash
 * routers keep the screen's route in the fragment, so it stays up to any `?`,
 * unless it carries values, such as a sign-in token.
 */
export function pageAddress(raw: string): string {
  const u = new URL(raw)
  u.username = ''
  u.password = ''
  u.search = ''
  const [fragment] = u.hash.split('?')
  u.hash = fragment.includes('=') ? '' : fragment
  return u.href
}

export function pageIdentity(raw: string): string {
  const u = new URL(pageAddress(raw))
  u.hash = ''
  return u.href
}
