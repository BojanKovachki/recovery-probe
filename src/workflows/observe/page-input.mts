import type { ObservationReadInput } from '../../core/screen.mjs'
import type { ObservationConfig } from './config.mjs'

/** What the page reads each sample; it never sees row state labels. */
export function pageReadInput(
  c: ObservationConfig,
  kitToken: string,
): ObservationReadInput {
  return {
    regionSelector: c.regionSelector,
    contentSelector: c.contentSelector,
    detail: c.detail,
    kitToken,
    ...(c.rows
      ? {
          rows: {
            selector: c.rows.selector,
            key: c.rows.key,
            state: c.rows.state,
            // Only the selectors reach the page; it answers with an index into them.
            markers: Object.values(c.rows.markers ?? {}),
          },
        }
      : {}),
  }
}

/** Every selector the configuration names, for the page to validate up front. */
export const pageSelectors = (c: ObservationConfig) => [
  c.regionSelector,
  c.contentSelector,
  ...(c.rows
    ? [
        c.rows.selector,
        ...(c.rows.key ? [c.rows.key] : []),
        ...(c.rows.state ? [c.rows.state] : []),
        ...Object.values(c.rows.markers ?? {}),
      ]
    : []),
]
