import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');

// Runs in the page. Neither raw text nor attribute values are persisted.
export function readRegion(selector) {
  const roots = selector ? document.querySelectorAll(selector) : null;
  if (roots && roots.length !== 1) throw new Error('regionSelector must identify one region');
  const root = roots?.[0] ?? document.querySelector('main, [role="main"]') ?? document.body;
  const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none');
  const nodes = [...root.querySelectorAll('*')].filter(visible).slice(0, 5000);
  const count = s => [...root.querySelectorAll(s)].filter(visible).length;
  const text = (root.innerText ?? '').replace(/\s+/g, ' ').trim();
  const tag = e => e.tagName.toLowerCase();
  const shape = e => [tag(e), ...[...e.children].filter(visible).slice(0, 20).map(tag)].join('/');
  const path = e => {
    const parts = [];
    while (e !== root && e.parentElement) { parts.unshift([...e.parentElement.children].indexOf(e)); e = e.parentElement; }
    return parts.join('/');
  };
  const groups = {}, distributions = {}, structure = {};
  for (const e of nodes) structure[tag(e)] = (structure[tag(e)] ?? 0) + 1;
  // Match repeated structural families at stable parent positions. No app classes,
  // endpoint names, visible strings or framework knowledge are used as selectors.
  for (const parent of [root, ...nodes]) {
    if (Object.keys(groups).length >= 100) break;
    if (parent.closest('nav, header, footer')) continue;
    const families = new Map();
    for (const child of [...parent.children].filter(visible)) {
      if (['script', 'style', 'option'].includes(tag(child))) continue;
      const key = shape(child); const family = families.get(key) ?? [];
      family.push(child); families.set(key, family);
    }
    for (const [shapeKey, children] of families) {
      if (children.length < 2) continue;
      const key = `${path(parent)}:${shapeKey}`;
      groups[key] = children.length;
      // Column/value shifts are facts, not claims about roles or permissions.
      const values = {};
      children.slice(0, 200).forEach(child => {
        const cells = [...child.children].filter(visible);
        (cells.length ? cells : [child]).slice(0, 20).forEach((cell, index) => {
          const value = (cell.innerText ?? '').replace(/\s+/g, ' ').trim();
          if (!value) return;
          const bucket = values[index] ??= Object.create(null);
          bucket[value] = (bucket[value] ?? 0) + 1;
        });
      });
      distributions[key] = values;
    }
  }
  return { text, structure, groups, distributions,
    region: selector ? 'selected' : root === document.body ? 'body' : 'main',
    truncated: root.querySelectorAll('*').length > 5000,
    visible: document.visibilityState === 'visible', online: navigator.onLine,
    items: count('tbody tr, [role="row"]:not(:has([role="columnheader"])), [role="listitem"], li'),
    images: count('img, [role="img"], svg'), links: count('a[href]'), buttons: count('button, [role="button"]'),
    loading: count('[role="progressbar"], [aria-busy="true"]') > 0 || /\b(loading|laden|lädt)\b/i.test(text),
    empty: /\b(no (files|items|results|data)|nothing (here|found)|empty|keine (dateien|einträge|ergebnisse))\b/i.test(text),
    error: count('[role="alert"]') > 0 || /\b(error|failed|unable to|something went wrong|fehler|fehlgeschlagen)\b/i.test(text),
    retry: [...root.querySelectorAll('button, [role="button"]')].some(e => visible(e) && /\b(retry|try again|erneut versuchen|wiederholen)\b/i.test(e.innerText || e.getAttribute('aria-label') || '')),
  };
}
export function summarizeRegion(raw) {
  const { text, distributions = {}, ...summary } = raw;
  const values = {};
  for (const [family, columns] of Object.entries(distributions)) {
    values[family] = {};
    for (const [column, distribution] of Object.entries(columns)) {
      values[family][column] = Object.fromEntries(Object.entries(distribution).map(([value, count]) => [hash(value), count]).sort());
    }
  }
  const structuralFingerprint = hash(JSON.stringify({ structure: summary.structure, groups: summary.groups }));
  return { ...summary, distributions: values, textLength: text.length, textFingerprint: hash(text), structuralFingerprint,
    fingerprint: hash(JSON.stringify([text, summary.structure, summary.groups, values])) };
}
export function compareRegions(before, after) {
  const lostFamilies = Object.entries(before.groups ?? {}).filter(([key, count]) => count >= 2 && !after.groups?.[key]).map(([family, count]) => ({ family, before: count, after: 0 }));
  const distributionChanges = [];
  for (const [family, columns] of Object.entries(before.distributions ?? {})) {
    if (!after.distributions?.[family]) continue;
    for (const [column, values] of Object.entries(columns)) {
      const next = after.distributions[family][column] ?? {};
      if (JSON.stringify(values) !== JSON.stringify(next)) distributionChanges.push({ family, column, before: values, after: next });
    }
  }
  return { before: { items: before.items ?? 0, images: before.images ?? 0, groups: before.groups ?? {}, structure: before.structure ?? {} },
    after: { items: after.items ?? 0, images: after.images ?? 0, groups: after.groups ?? {}, structure: after.structure ?? {} },
    indicators: { loading: after.loading, error: after.error, retry: after.retry, empty: after.empty },
    lostFamilies, distributionChanges,
    structureChanged: before.structuralFingerprint !== after.structuralFingerprint,
    textChanged: before.textFingerprint !== after.textFingerprint,
    regionReplacedCandidate: lostFamilies.length > 0 && before.structuralFingerprint !== after.structuralFingerprint,
    contentLoss: (before.items > 0 && after.items === 0) || (before.images > 0 && after.images === 0) || lostFamilies.length > 0 };
}
export function classifyObservation({ baseline, final, injected, expected, recovered, newErrors = 0 }) {
  const result = (classification, kind, confidence = 'medium') => ({ classification, kind, confidence });
  if (injected !== expected) return result('FAULT_NOT_TRIGGERED', 'inconclusive', 'high');
  if (newErrors > 0) return result('UNCAUGHT_ERROR', 'suspected-defect');
  if (recovered) return result('RECOVERED', 'observation', 'high');
  if (final.error || final.retry) return result('ERROR_OR_RETRY_SHOWN', 'observation');
  if (final.loading) return result('LOADING_AT_DEADLINE', 'decision-needed');
  if (!baseline.empty && baseline.textLength > 0 && final.empty) return result('SILENT_EMPTY', 'suspected-defect');
  if (compareRegions(baseline, final).contentLoss) return result('CONTENT_LOSS', 'suspected-defect');
  return result('UI_DIFFERENCE_AT_DEADLINE', 'decision-needed', 'low');
}
