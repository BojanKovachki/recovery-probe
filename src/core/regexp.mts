/** `value` with RegExp syntax characters escaped, so a RegExp matches it literally. */
export const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
