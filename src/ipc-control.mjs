/** A failed reply does not mean a mutation failed to execute. Never retry begin.
 * Reset its exact ID and independently read back state, even if reset's reply fails.
 * Do not use an unscoped reset: that could disarm another client's newer run.
 */
export async function resetIpcAndConfirm(control, id) {
  if (typeof id !== 'string' || !id) throw new Error('A run ID is required for scoped cleanup');
  let resetError;
  try { await control.call('reset', id); } catch (error) { resetError = error; }
  let snapshot;
  try { snapshot = await control.call('snapshot'); }
  catch (error) { throw new Error(`IPC cleanup unverified: cannot read back state (${error.message}). Stop the test app; a fault may remain armed until its TTL expires.`); }
  if (snapshot !== null && (!snapshot || !Object.hasOwn(snapshot, 'armed') || snapshot.armed !== null)) {
    throw new Error(`IPC cleanup unverified: a plan may remain armed${resetError ? ' (' + resetError.message + ')' : ''}. Stop the test app; do not continue testing.`);
  }
  return snapshot;
}
