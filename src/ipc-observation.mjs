import { createHash } from 'node:crypto';

// Executed in the renderer. Text is used transiently for comparison, never saved.
export function readRegion() {
  const root = document.querySelector('main, [role="main"]') ?? document.body;
  const text = (root?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const visible = element => !!(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const count = selector => [...root.querySelectorAll(selector)].filter(visible).length;
  return {
    text, region: root === document.body ? 'body' : 'main',
    visible: document.visibilityState === 'visible', online: navigator.onLine,
    items: count('tbody tr, [role="row"], [role="listitem"]'),
    loading: count('[role="progressbar"], [aria-busy="true"]') > 0 || /\bloading\b/i.test(text),
    empty: /\b(no (files|items|results|data)|nothing (here|found)|empty)\b/i.test(text),
    error: count('[role="alert"]') > 0 || /\b(error|failed|unable to|something went wrong)\b/i.test(text),
    retry: [...root.querySelectorAll('button, [role="button"]')].some(e => visible(e) && /\b(retry|try again)\b/i.test(e.innerText)),
  };
}
export function summarizeRegion(raw) {
  const { text, ...summary } = raw;
  return { ...summary, textLength: text.length, fingerprint: createHash('sha256').update(text).digest('hex') };
}
export function classifyObservation({ baseline, final, injected, expected, recovered, newErrors = 0 }) {
  if (injected !== expected) return { classification: 'FAULT_NOT_TRIGGERED', kind: 'inconclusive' };
  if (newErrors > 0) return { classification: 'UNCAUGHT_ERROR', kind: 'suspected-defect' };
  if (recovered) return { classification: 'RECOVERED', kind: 'observation' };
  if (!baseline.empty && baseline.textLength > 0 && final.empty && !final.error && !final.retry && !final.loading)
    return { classification: 'SILENT_EMPTY', kind: 'suspected-defect' };
  if (final.error || final.retry) return { classification: 'ERROR_OR_RETRY_SHOWN', kind: 'observation' };
  if (final.loading) return { classification: 'LOADING_AT_DEADLINE', kind: 'decision-needed' };
  return { classification: 'UI_DIFFERENCE_AT_DEADLINE', kind: 'decision-needed' };
}
