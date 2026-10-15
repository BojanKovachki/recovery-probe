import { readFileSync } from 'node:fs'

const entities = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes text for HTML element content or a quoted attribute value. */
export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => entities[c])

/**
 * Fills `report-templates/<name>.html`. `{{slot}}` takes text and escapes it;
 * `{{{slot}}}` takes markup the caller already built with escaped values.
 */
export function renderTemplate(name, slots) {
  const template = readFileSync(
    new URL(`./report-templates/${name}.html`, import.meta.url),
    'utf8',
  )
  return template.replace(
    /\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g,
    (_, markupSlot, textSlot) => {
      const slot = markupSlot ?? textSlot
      if (!Object.hasOwn(slots, slot))
        throw new Error(`Report template ${name} needs a value for ${slot}`)
      return markupSlot ? String(slots[slot]) : escapeHtml(slots[slot])
    },
  )
}
