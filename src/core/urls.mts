export function pageIdentity(raw: string): string {
  const u = new URL(raw)
  u.username = ''
  u.password = ''
  u.search = ''
  u.hash = ''
  return u.href
}
