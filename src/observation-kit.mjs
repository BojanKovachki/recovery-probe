// In-page helpers for fault-free observation. Installed once per capture without
// reloading; removed at the end. Records only configured action names, times and
// whether the browser marked the click as a real user input.

const SELECTOR_KEYS = ['css', 'role', 'name', 'text'];

/** Node-side validation of a CSS string or { css, role, name, text } selector. */
export function selectorSpec(value, key) {
  if (typeof value === 'string') {
    if (!value.trim()) throw Error(`${key} must be a non-empty CSS selector`);
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${key} must be a CSS selector string or { css, role, name, text }`);
  for (const property of Object.keys(value)) if (!SELECTOR_KEYS.includes(property)) throw Error(`Unsupported ${key} property: ${property}`);
  if (value.css === undefined && value.role === undefined) throw Error(`${key} needs css or role`);
  if (value.css !== undefined && (typeof value.css !== 'string' || !value.css.trim())) throw Error(`${key}.css must be a non-empty CSS selector`);
  if (value.role !== undefined && (typeof value.role !== 'string' || !/^[a-z]{2,30}$/.test(value.role))) throw Error(`${key}.role must be an ARIA role name`);
  for (const property of ['name', 'text']) {
    if (value[property] !== undefined && (typeof value[property] !== 'string' || !value[property].trim() || value[property].length > 200)) throw Error(`${key}.${property} must be 1–200 characters`);
  }
  if (value.name !== undefined && value.role === undefined) throw Error(`${key}.name requires role`);
  return { ...value };
}

// Runs in the page. Self-contained: page.evaluate serializes this function.
export function installObserverKit({ token, actions, validate = [] }) {
  const existing = globalThis.__recoveryProbeObserve;
  if (existing) {
    if (existing.token === token) return true;
    // A capture polls its kit on every sample; one unpolled for 15 s was abandoned (for example a crashed CLI).
    if (Date.now() - existing.lastPolledAt() < 15000) throw new Error('OBSERVER_ALREADY_ACTIVE: another observation owns this page');
    existing.stop();
  }
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const implicitRole = e => {
    const tag = e.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && e.hasAttribute('href')) return 'link';
    if (tag === 'input') {
      const type = (e.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      return type === 'checkbox' || type === 'radio' ? type : 'textbox';
    }
    return { tr: 'row', td: 'cell', th: 'columnheader', li: 'listitem', ul: 'list', ol: 'list', table: 'table', img: 'img', textarea: 'textbox', select: 'combobox', nav: 'navigation', main: 'main', dialog: 'dialog' }[tag]
      ?? (/^h[1-6]$/.test(tag) ? 'heading' : null);
  };
  const roleOf = e => normalize(e.getAttribute('role')).split(' ')[0] || implicitRole(e);
  // Approximation of the accessible name: aria-label, aria-labelledby, visible text, title/alt.
  const nameOf = e => {
    const labelledBy = normalize(e.getAttribute('aria-labelledby'));
    const byIds = labelledBy ? labelledBy.split(' ').map(id => document.getElementById(id)?.innerText ?? '').join(' ') : '';
    return normalize(e.getAttribute('aria-label') || byIds || e.innerText || e.getAttribute('title') || e.getAttribute('alt') || '');
  };
  const matches = (e, spec) => {
    if (typeof spec === 'string') return e.matches(spec);
    return (!spec.css || e.matches(spec.css)) && (!spec.role || roleOf(e) === spec.role)
      && (spec.name === undefined || nameOf(e) === spec.name) && (spec.text === undefined || normalize(e.innerText) === spec.text);
  };
  const select = (root, spec) => typeof spec === 'string'
    ? [...root.querySelectorAll(spec)]
    : [...root.querySelectorAll(spec.css ?? '*')].filter(e => matches(e, spec));
  const closest = (element, spec) => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) if (matches(node, spec)) return node;
    return null;
  };
  // Validate every selector now, so a CSS error surfaces before the capture starts.
  for (const spec of [...validate, ...actions.map(action => action.selector)]) select(document, spec);
  const buffer = [];
  let polledAt = Date.now();
  const onClick = event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    for (const action of actions) {
      if (!closest(target, action.selector)) continue;
      buffer.push({ name: action.name, at: Date.now(), trusted: event.isTrusted });
      if (buffer.length > 500) buffer.shift();
    }
  };
  if (actions.length) document.addEventListener('click', onClick, true);
  Object.defineProperty(globalThis, '__recoveryProbeObserve', {
    configurable: true,
    value: Object.freeze({ token, select, normalize, lastPolledAt: () => polledAt,
      drainActions: () => { polledAt = Date.now(); return buffer.splice(0); },
      stop: () => document.removeEventListener('click', onClick, true) }),
  });
  return true;
}

// Runs in the page.
export function removeObserverKit(token) {
  const kit = globalThis.__recoveryProbeObserve;
  if (!kit || kit.token !== token) return false;
  kit.stop();
  delete globalThis.__recoveryProbeObserve;
  return true;
}
