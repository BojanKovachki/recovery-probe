/** Polls `condition` until it returns true; throws `Timed out: <what>` after `ms`. */
export async function until(condition, ms, what) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await condition().catch(() => false)) return
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export const visible = (page, text) =>
  page
    .getByText(text, { exact: false })
    .first()
    .isVisible()
    .catch(() => false)
