const STATES = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Outage',
}

export const stateLabel = (state) => STATES[state] ?? state

/** "09:15" in the viewer's time zone. */
export const clock = (iso) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })

/** Newest first. */
export const newestFirst = (items) =>
  [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
