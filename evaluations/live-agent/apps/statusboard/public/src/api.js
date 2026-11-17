async function request(path, options) {
  const response = await fetch(path, options)
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} for ${path}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

export const account = () => request('/api/account')
export const listServices = () => request('/api/services')
export const listNotifications = () => request('/api/notifications')
export const sync = () => request('/api/sync', { method: 'POST' })
