// Merges the items a sync returned into the local list. A sync that stopped
// early keeps only the items it returned.
export function applySync(local, synced, { complete = true } = {}) {
  if (!complete) return [...synced]
  const byId = new Map(local.map((item) => [item.id, item]))
  for (const item of synced) byId.set(item.id, item)
  return [...byId.values()]
}
