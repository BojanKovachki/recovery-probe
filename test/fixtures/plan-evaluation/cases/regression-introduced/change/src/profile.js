const MAX_ATTEMPTS = 2

export async function loadProfile(document, attempt = 1) {
  const status = document.querySelector('#status')
  const profile = document.querySelector('#profile')
  status.textContent = 'Loading'
  try {
    const response = await fetch('/api/profile')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { name } = await response.json()
    profile.textContent = name
    profile.hidden = false
    status.textContent = ''
  } catch {
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => loadProfile(document, attempt + 1), 100)
      return
    }
    status.textContent = 'Could not load the profile.'
  }
}
