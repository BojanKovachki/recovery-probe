// Reads an attempt's stream-json transcript: the final report, its cost and tools, and any
// reach outside the attempt's workspace.

/** The transcript's JSON events; lines that are not JSON are skipped. */
export function events(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

/** Every tool call: its name and input. */
export function toolCalls(all) {
  return all
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ name: block.name, input: block.input }))
}

const count = (names) =>
  names.reduce(
    (counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }),
    {},
  )

/** What the attempt reported, how long it took and what it used. */
export function summarize(all) {
  const result = all.findLast((event) => event.type === 'result')
  const calls = toolCalls(all)
  const usage = result?.usage ?? {}
  return {
    report: result?.structured_output ?? null,
    resultSubtype: result?.subtype ?? null,
    metrics: {
      durationMs: result?.duration_ms ?? null,
      turns: result?.num_turns ?? null,
      costUsd: result?.total_cost_usd ?? null,
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
      toolCalls: calls.length,
      tools: count(calls.map((call) => call.name)),
      recoveryProbeCalls: calls.filter(
        (call) =>
          call.name.startsWith('mcp__recovery-probe') ||
          JSON.stringify(call.input).includes('recovery-probe '),
      ).length,
    },
  }
}

const normalize = (path) => path.replaceAll('\\', '/').toLowerCase()

/**
 * Tool calls that name a path the attempt has no business with: the evaluation's checkout, the
 * key folder, Claude's own files or the user's other projects. They are flagged, not judged.
 */
export function outsideReach(all, { workspace, watched }) {
  const own = normalize(workspace)
  const marks = watched.map(normalize)
  return toolCalls(all).flatMap((call) => {
    const text = normalize(JSON.stringify(call.input))
      .replaceAll('\\\\', '/')
      .replaceAll(own, '<workspace>')
    const hits = marks.filter((mark) => text.includes(mark))
    return hits.length
      ? [{ tool: call.name, matched: hits, input: text.slice(0, 300) }]
      : []
  })
}

/** `text` with every secret replaced. */
export function redact(text, secrets) {
  return secrets
    .filter((secret) => secret && secret.length >= 8)
    .reduce((clean, secret) => clean.replaceAll(secret, '[redacted]'), text)
}
