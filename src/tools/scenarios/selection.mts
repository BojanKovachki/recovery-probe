import type { Registry, RegistryEntry } from '../plan/registry.mjs'

/** A registry entry with no check the self-check can run: unreadable, or its check malformed. */
export interface InvalidEntry {
  /** Its name, or its position in the registry when it has none. */
  entry: string
  message: string
  /** Whether it concerns the selection; every entry does when no names are given. */
  selected: boolean
}

export type CheckEntry = RegistryEntry & { check: string[] }

/**
 * The registered checks to look at, the entries that could not be checked, and the names asked
 * for that the registry does not list at all. Nothing in the registry is left out.
 */
export function selection(registry: Registry, names: string[] = []) {
  const concerns = (name?: string) =>
    !names.length || (name !== undefined && names.includes(name))
  const checks = registry.entries
    .filter((e): e is CheckEntry => Boolean(e.check))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  const invalid: InvalidEntry[] = [
    ...registry.unusable.map(({ index, name, message }) => ({
      entry: name ?? `scenarios[${index}]`,
      message,
      selected: concerns(name),
    })),
    ...registry.entries
      .filter((e) => e.problem && !e.check)
      .map((e) => ({
        entry: e.name,
        message: e.problem!,
        selected: concerns(e.name),
      })),
  ]
  const listed = new Set([
    ...checks.map((e) => e.name),
    ...invalid.map((e) => e.entry),
  ])
  return {
    chosen: checks.filter((e) => concerns(e.name)),
    invalid,
    unknown: names.filter((name) => !listed.has(name)),
  }
}
