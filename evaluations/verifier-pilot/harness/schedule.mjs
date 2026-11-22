// The order of the sessions: every case in both arms, `repetitions` times, shuffled with a
// recorded seed, so the same seed always gives the same order.

/** A small seeded generator (mulberry32): the same seed gives the same sequence. */
function seeded(seed) {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Every session of the pilot, in a seeded random order.
 * @param {string[]} caseIds
 * @param {number} repetitions
 * @param {number} seed
 */
export function schedule(caseIds, repetitions, seed) {
  const sessions = caseIds.flatMap((id) =>
    ['A', 'B'].flatMap((arm) =>
      Array.from({ length: repetitions }, (_, i) => ({
        case: id,
        arm,
        repetition: i + 1,
      })),
    ),
  )
  const next = seeded(seed)
  for (let i = sessions.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[sessions[i], sessions[j]] = [sessions[j], sessions[i]]
  }
  return sessions.map((session, i) => ({
    ...session,
    id: `${String(i + 1).padStart(2, '0')}-${session.case}-${session.arm}${session.repetition}`,
  }))
}
