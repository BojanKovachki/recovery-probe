import { createRequire } from 'node:module'

// This module sits two folders below the package root, in src/core and dist/core alike.
const root = new URL('../../', import.meta.url)

/** A file that ships with the package, such as bin/recovery-probe.mjs. */
export const packageUrl = (path: string): URL => new URL(path, root)

export const { version } = createRequire(import.meta.url)(
  '../../package.json',
) as { version: string }
