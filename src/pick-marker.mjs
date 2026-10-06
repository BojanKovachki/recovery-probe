/** Pick an existing, unique DOM element without changing application source. */
export async function pickMarker(page, { timeoutMs = 120000 } = {}) {
  await page.bringToFront();
  return page.evaluate(({ timeoutMs }) => new Promise((resolve, reject) => {
    const host = document.createElement('div');
    host.setAttribute('data-recovery-probe-picker', '');
    const shadow = host.attachShadow({ mode: 'closed' });
    const banner = document.createElement('div');
    banner.textContent = 'Recovery Probe: click content that proves the selected request loaded. Escape cancels.';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:16px;background:#17212f;color:white;font:16px system-ui;pointer-events:none';
    const outline = document.createElement('div');
    outline.style.cssText = 'position:fixed;border:3px solid #00b97c;box-sizing:border-box;pointer-events:none';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    shadow.append(banner, outline);
    document.documentElement.append(host);
    const clean = () => {
      clearTimeout(timer); host.remove();
      document.removeEventListener('click', click, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('keydown', key, true);
    };
    const target = event => event.composedPath()[0];
    const move = event => {
      const el = target(event);
      if (!(el instanceof Element) || el === host) return;
      const r = el.getBoundingClientRect();
      Object.assign(outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const click = event => {
      event.preventDefault(); event.stopImmediatePropagation();
      const el = target(event);
      if (!(el instanceof HTMLElement) || el === host || ['HTML', 'BODY', 'INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.getRootNode() !== document) {
        banner.textContent = 'Choose visible loaded content in the main page (not an input, whole page, iframe or shadow root). Escape cancels.';
        return;
      }
      const unique = selector => document.querySelectorAll(selector).length === 1;
      let selector;
      for (const attr of ['data-testid', 'data-test', 'id']) {
        const value = el.getAttribute(attr);
        if (value && value.length < 200) {
          const candidate = `[${attr}=${JSON.stringify(value)}]`;
          if (unique(candidate)) { selector = candidate; break; }
        }
      }
      if (!selector) {
        const path = [];
        for (let current = el; current && current !== document.documentElement; current = current.parentElement) {
          const siblings = [...current.parentElement.children].filter(item => item.tagName === current.tagName);
          path.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
          if (unique(path.join(' > '))) break;
        }
        selector = path.join(' > ');
      }
      const text = el.innerText.trim();
      clean();
      resolve({ readySelector: selector, ...(text && text.length <= 160 ? { readyText: text } : {}) });
    };
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); clean(); reject(new Error('Selection cancelled. No faults were injected.')); }
    };
    const timer = setTimeout(() => { clean(); reject(new Error('Selection timed out. Run start again to pick loaded content.')); }, timeoutMs);
    document.addEventListener('click', click, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('keydown', key, true);
  }), { timeoutMs });
}
