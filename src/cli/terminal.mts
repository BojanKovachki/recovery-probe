import { createInterface, type Interface } from 'node:readline/promises'
import type { StartIo } from '../tools/guided-start.mjs'

/** Questions and answers in the terminal; close it when done. */
export function terminalIo(): StartIo & { close(): void } {
  let terminal: Interface | undefined
  return {
    interactive: Boolean(process.stdin.isTTY),
    log: (text) => console.log(text),
    ask: async (prompt) => {
      if (!process.stdin.isTTY)
        throw new Error('This choice requires an interactive terminal.')
      terminal ??= createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      return terminal.question(prompt)
    },
    close: () => terminal?.close(),
  }
}
