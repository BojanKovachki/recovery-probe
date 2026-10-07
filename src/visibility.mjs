export async function windowVisibility(page, control) {
  const visible = await page.evaluate(() => document.visibilityState);
  // Electron's Browser domain can report normal while the native window differs.
  // Prefer the explicitly installed dev hook when it exposes native state.
  if (control) {
    try { const state = await control.call('windowState'); return { visibility: visible, windowState: state.minimized ? 'minimized' : 'normal', mechanism: 'electron', diagnosis: visible === 'visible' ? 'visible' : state.minimized ? 'minimized' : 'hidden-not-minimized: possibly covered; keep the window uncovered' }; } catch {}
  }
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    const info = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    return { visibility: visible, windowState: info.bounds.windowState, windowId: info.windowId, mechanism: 'cdp', diagnosis: visible === 'visible' ? 'visible' : info.bounds.windowState === 'minimized' ? 'minimized' : 'hidden-not-minimized: possibly covered; keep the window uncovered' };
  } catch {
    if (control) {
      try {
        const state = await control.call('windowState');
        return { visibility: visible, windowState: state.minimized ? 'minimized' : 'normal', mechanism: 'electron', diagnosis: visible === 'visible' ? 'visible' : state.minimized ? 'minimized' : 'hidden-not-minimized: possibly covered; keep the window uncovered' };
      } catch {}
    }
    return { visibility: visible, mechanism: 'unavailable', diagnosis: visible === 'visible' ? 'visible' : 'hidden: window state unavailable; restore and uncover the target window' };
  } finally { await session?.detach().catch(() => {}); }
}
export async function prepareVisibility(page, { restoreWindow = false, control, announce = console.log } = {}) {
  const initial = await windowVisibility(page, control);
  let changed = false;
  const set = async state => {
    if (initial.mechanism === 'electron') return control.call('setWindowMinimized', state === 'minimized');
    const session = await page.context().newCDPSession(page);
    try { await session.send('Browser.setWindowBounds', { windowId: initial.windowId, bounds: { windowState: state } }); }
    finally { await session.detach(); }
  };
  const revert = async () => {
    if (!changed) return { changed: false, restored: true };
    await set(initial.windowState);
    let final;
    for (let i = 0; i < 20; i++) { final = await windowVisibility(page, control); if (final.windowState === initial.windowState) break; await new Promise(r => setTimeout(r, 50)); }
    if (final.windowState !== initial.windowState) throw new Error('Window state restoration unverified');
    return { changed: true, restored: true, final };
  };
  if (restoreWindow && initial.windowState === 'minimized') {
    announce('Recovery Probe: restoring the minimized target window for this run; its original state will be restored afterwards.');
    changed = true; // An unsuccessful reply may still have executed.
    try {
      await set('normal');
      let current;
      for (let i = 0; i < 20; i++) { current = await windowVisibility(page, control); if (current.windowState !== 'minimized') break; await new Promise(r => setTimeout(r, 50)); }
      if (current.windowState === 'minimized') throw new Error('Un-minimizing was not observed');
    }
    catch (error) {
      try { await revert(); } catch { throw new Error('Window operation failed and restoration is unverified'); }
      throw error;
    }
  }
  return { initial, changed, revert };
}
