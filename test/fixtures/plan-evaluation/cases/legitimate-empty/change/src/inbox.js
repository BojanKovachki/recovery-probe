const MAX_ATTEMPTS = 4

const render = (document, messages) => {
  document.querySelector('#messages').innerHTML = messages
    .map((message) => `<li>${message.subject}</li>`)
    .join('')
  document.querySelector('#inbox-empty').hidden = messages.length > 0
}

export async function loadInbox(document, attempt = 1) {
  const error = document.querySelector('#inbox-error')
  try {
    const response = await fetch('/api/inbox')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    render(document, await response.json())
    error.hidden = true
  } catch {
    error.hidden = false
    if (attempt < MAX_ATTEMPTS)
      setTimeout(() => loadInbox(document, attempt + 1), 100)
  }
}
