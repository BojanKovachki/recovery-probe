/** Synthetic application controller shared by the browser fixture and Node tests. */
export function createProfileController(fetchProfile, { fixed = true, onChange = () => {} } = {}) {
  let pending = false;
  let state = { phase: 'idle', name: null };
  const setState = (next) => { state = next; onChange({ ...state }); };
  return {
    getState: () => ({ ...state }),
    async load() {
      if (pending) return;
      pending = true;
      setState({ phase: 'loading', name: null });
      try {
        const response = await fetchProfile();
        if (!response.ok) throw new Error('Request failed');
        const data = await response.json();
        setState({ phase: 'ready', name: data.name });
        pending = false;
      } catch {
        setState({ phase: 'error', name: null });
      } finally {
        // The broken fixture intentionally leaves pending set on failure.
        if (fixed) pending = false;
      }
    },
  };
}
