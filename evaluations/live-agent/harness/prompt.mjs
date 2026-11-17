// The task prompt and the final report every attempt gives. Both conditions get the same
// text; B adds one paragraph naming the extra tool, and nothing about the fix.

const COMMON = `You are a software engineer on this project. Resolve the issue described in ISSUE.md.

- The product requirements are in docs/REQUIREMENTS.md. Do not change them.
- \`npm start\` serves the app on http://127.0.0.1:4173 and \`npm test\` runs its tests. Playwright and its Chromium are installed if you want to drive the page.
- If the issue and the requirements leave the expected behavior undecided, do not guess: report needs_clarification and ask your question.
- Work only inside this directory.

When you are done, report your status:
- fixed: you changed the code and the issue is resolved;
- not_fixed: you could not resolve it;
- no_change_needed: the app already behaves as required;
- needs_clarification: you need a decision before changing the behavior.
Also say what you found and changed, and how you checked it.`

const RECOVERY_PROBE = `Recovery Probe is available: its MCP server (recovery-probe) is connected, the \`recovery-probe\` command is on the PATH, and recovery-probe.registry.json maps this project's source files to prepared checks. The \`observe\` checks attach to a browser on port 9222: with the app running, \`node checks/open-browser.mjs\` opens one.`

export function promptFor(condition) {
  return condition === 'B' ? `${COMMON}\n\n${RECOVERY_PROBE}` : COMMON
}

export const STATUSES = [
  'fixed',
  'not_fixed',
  'no_change_needed',
  'needs_clarification',
]

/** The structured final report (`--json-schema`). */
export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: STATUSES },
    summary: { type: 'string' },
    verification: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
}
