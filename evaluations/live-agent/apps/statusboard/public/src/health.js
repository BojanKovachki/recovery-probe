import { stateLabel } from './format.js'
import { withRetry } from './retry.js'

function serviceRow(service) {
  const item = document.createElement('li')
  item.dataset.service = service.id
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = service.name
  const state = document.createElement('span')
  state.className = `state ${service.state}`
  state.textContent = stateLabel(service.state)
  item.append(name, state)
  return item
}

/** The service health panel: loads the services, retrying failed reads. */
export function createHealth(panel, api) {
  async function load() {
    panel.status.textContent = 'Loading…'
    panel.error.hidden = true
    try {
      const services = await withRetry(() => api.listServices())
      panel.list.replaceChildren(...services.map(serviceRow))
      panel.status.textContent = ''
    } catch {
      panel.status.textContent = ''
      panel.error.hidden = false
    }
  }
  panel.retry.addEventListener('click', load)
  return { load }
}
