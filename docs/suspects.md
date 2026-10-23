# Suspect scanner (experimental)

Some error handling loses data without showing an error. A failed read becomes an empty list, and the code after it clears the screen or deletes files. `recovery-probe suspects` reads JavaScript and TypeScript sources for two such patterns, without running them. Each suspect names the read to fail and the check that proves or dismisses it, so a lead from the code turns into an experiment on the running app.

Use it while you write a change, or let an AI coding agent run it before it says the change handles failures.

## Requirements

TypeScript in the project, which also parses JavaScript:

```bash
npm install --save-dev typescript
```

It is an optional peer dependency, loaded from where Recovery Probe is installed. No other command needs it.

## Run it

```bash
npx recovery-probe suspects src
npx recovery-probe suspects --changed-since main
npx recovery-probe suspects --changed-since main --json
```

- **Paths** are files and directories; the default is the working directory. The scan skips `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.git`, `.recovery-probe` and declaration files. It also skips test files (`*.test.*`, `*.spec.*`, `__tests__`, `__mocks__`) unless you pass `--include-tests`.
- **`--changed-since REF`** scans only the files changed since a Git reference, uncommitted and untracked ones included. With paths, it scans the changed files under them.
- **`--json`** prints `{ scanned, suspects }`. Each suspect has `pattern`, `file`, `line`, `column`, `code`, `why`, `read` (when it can be told) and `check`.
- **Exit code** 0 means no suspects, and 2 means suspects to review. A suspect is never a failure (exit 1).

## Patterns

### UNKNOWN_AS_EMPTY

A failed or unexpected read becomes an empty collection. The code after it cannot tell "unknown" from "none", so it may show nothing, or clear or delete what it had.

```ts
// A failed read looks like "no files", and the update removes them all.
const files = (await listInstalledFiles(item)) ?? []

const rows = await load().catch(() => [])

if (Array.isArray(result)) setRooms(result)
else setRooms([]) // an unexpected answer clears the list
```

Flagged:
- `?? []` or `|| []` straight after an `await`;
- a `.catch` that returns `[]` or `{}`;
- a `catch` block that returns one after an `await`;
- a state setter that stores an empty collection in a `catch`, in a `.catch` or `onError` callback, or in the branch where a result is not an array.

A real default such as `?? 'Unknown'`, or `.catch(() => undefined)`, keeps "unknown" apart and is not flagged.

### FAILURE_ONLY_LOGGED

A read updates state when it succeeds, but its failure is only logged. The data never arrives, and nothing retries or tells the user.

```ts
fetchContacts()
  .then((contacts) => setContacts(contacts))
  .catch(logFetchError)
```

It is flagged only when the success path stores the read's result. An action that only toggles a flag, such as `save().then(() => setSaving(false))`, is not flagged.

Both patterns go by names:
- **Setters** are calls named `set...`, such as `setState`, `setSelf`, `setRows` and `setQueryData`. Timers and DOM setters don't count.
- **Logging** is a handler that only calls functions whose names contain log, report, warn, console, trace, debug, ignore or noop, or that does nothing.

## Prove or dismiss a suspect

A suspect is a lead from reading code, not a bug. Fail its read once:
- **UNKNOWN_AS_EMPTY** is confirmed by content that disappears (`check_read_recovery`, `discover`) or by files removed from disk (`observe --files`).
- **FAILURE_ONLY_LOGGED** is confirmed when the data never comes back and no error shows, which `check_read_recovery` reports as `RECOVERY_NOT_OBSERVED`.

When a reviewed suspect is fine, for example an empty cache that is only a cache miss, mark the line. The comment works on the flagged line or the line above:

```ts
// recovery-probe-ignore: an empty cache is a cache miss
const cache = (await readCache()) ?? {}
```

## From an AI coding agent

The [MCP server](mcp.md) has a `find_suspects` tool. It takes `paths`, `changedSince` and `includeTests`, and returns the same suspects: at most 200, with `found` as the total. Ask the agent to run it with `changedSince: "main"`, then fail each suspect's read with the check it names.

## How it was checked

It was tried on three bugs fixed in a production Electron app:
- a list cleared when a read failed;
- installed content deleted after a failed file listing;
- contacts that never loaded because their failure was only logged.

On the code before each fix, it flagged the lines behind the bug. On the fixed code, it flagged none of them. Across the app's roughly 1,000 source files, it reported 15 suspects.

## Limits

- It reads one file at a time, by syntax. It does not follow a read into another function or file, and it does not use types. For example, `const files = await read()` followed later by `files ?? []` is not flagged.
- Names decide what counts as a setter and what counts as logging. A store or logger with another kind of name is missed, and an unusual name can make a false lead.
- It covers two patterns. Other ways to lose data, such as a save that fails without telling the user, are outside it.
