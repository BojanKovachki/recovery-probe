import { clock } from './format.js'

/** "Sync now": asks the server to refresh every service from upstream, then reloads the panel. */
export function createSync(controls, api, afterSync) {
  controls.button.addEventListener('click', async () => {
    controls.button.disabled = true
    controls.status.textContent = 'Syncing…'
    try {
      const result = await api.sync()
      controls.status.textContent = `Last synced at ${clock(result.syncedAt)}`
      await afterSync(result)
    } catch {
      controls.status.textContent = 'Sync failed.'
    } finally {
      controls.button.disabled = false
    }
  })
}
