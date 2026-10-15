// Synthetic content only; shared by the browser checks and local benchmark.
export function observationTable(rows = 200) {
  return `<main id="panel"><header><button id="control">Refresh</button></header><ul>${Array.from(
    { length: rows },
    (_, i) =>
      `<li data-record><div><span>synthetic-record-${i}</span><span>group-${i % 4}</span><span>ready</span></div><div><button>Open</button></div></li>`,
  ).join('')}</ul></main>`
}
