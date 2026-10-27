/** The terminal, or a test double: where questions go and answers come from. */
export interface StartIo {
  interactive?: boolean
  log(message: string): void
  ask(prompt: string): Promise<string>
}

/** Untrusted text made safe to print: no terminal control characters, at most 240 long. */
export const safeLabel = (text: string) =>
  String(text)
    // eslint-disable-next-line no-control-regex -- strips terminal control characters from untrusted text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .slice(0, 240)

const listChoices = <T,>(
  io: StartIo,
  prompt: string,
  choices: { label: string; value: T }[],
) => {
  io.log(prompt)
  choices.forEach((choice, index) =>
    io.log(`  ${index + 1}. ${safeLabel(choice.label)}`),
  )
}

export async function choose<T>(
  io: StartIo,
  prompt: string,
  choices: { label: string; value: T }[],
): Promise<T> {
  if (!choices.length) throw new Error(`No choices available: ${prompt}`)
  if (choices.length === 1) {
    io.log(`Selected: ${safeLabel(choices[0].label)}`)
    return choices[0].value
  }
  listChoices(io, prompt, choices)
  while (true) {
    const answer = (await io.ask('Choose a number: ')).trim()
    if (/^[1-9]\d*$/.test(answer) && choices[Number(answer) - 1])
      return choices[Number(answer) - 1].value
    io.log('Enter one of the displayed numbers.')
  }
}

/** Any number of the choices, including none. */
export async function chooseMany<T>(
  io: StartIo,
  prompt: string,
  choices: { label: string; value: T }[],
): Promise<T[]> {
  if (!choices.length) return []
  listChoices(io, prompt, choices)
  while (true) {
    const answer = (
      await io.ask('Numbers separated by commas, or Enter for none: ')
    ).trim()
    const picks = answer ? answer.split(',').map((pick) => pick.trim()) : []
    if (
      picks.every(
        (pick) => /^[1-9]\d*$/.test(pick) && choices[Number(pick) - 1],
      )
    )
      return [...new Set(picks)].map((pick) => choices[Number(pick) - 1].value)
    io.log('Enter numbers from the list, separated by commas.')
  }
}
