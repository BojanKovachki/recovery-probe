/**
 * A stand-in typed as the real thing, from only the members a test needs. The type
 * comes from where it's used, so a misspelled member is a type error.
 * @template T
 * @param {{ [K in keyof NoInfer<T>]?: unknown }} members
 * @returns {T}
 */
export const fake = (members) =>
  /** @type {T} */ (/** @type {unknown} */ (members))
