// The order of a pilot's attempts: every task, condition and repetition, shuffled with a
// recorded seed so that the order is random yet reproducible.

/** mulberry32: a small seeded generator of numbers in [0, 1). */
export function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle(items, seed) {
  const next = random(seed)
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/** Every attempt of the pilot in the order to run them, each with a unique id. */
export function schedule({ tasks, conditions, repetitions, seed }) {
  const attempts = tasks.flatMap((task) =>
    conditions.flatMap((condition) =>
      Array.from({ length: repetitions }, (_, i) => ({
        task,
        condition,
        repetition: i + 1,
      })),
    ),
  )
  return shuffle(attempts, seed).map((attempt, i) => ({
    ...attempt,
    order: i + 1,
    id: `${String(i + 1).padStart(2, '0')}-${attempt.task}-${attempt.condition}${attempt.repetition}`,
  }))
}
