// Merges the items a sync returned into the local list.
export function applySync(local, synced) {
  const byId = new Map(local.map((item) => [item.id, item]))
  for (const item of synced) byId.set(item.id, item)
  return [...byId.values()]
}
