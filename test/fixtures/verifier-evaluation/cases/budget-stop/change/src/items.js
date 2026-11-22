// Lists the items the server knows.
export function createItemList(document) {
  let items = []
  const render = (error) => {
    document.querySelector('#items').innerHTML = items
      .map((item) => `<li>${item}</li>`)
      .join('')
    const message = document.querySelector('#error')
    message.textContent = error ?? ''
    message.hidden = !error
  }
  return {
    async refresh() {
      try {
        const response = await fetch('/api/items')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        items = await response.json()
        render()
      } catch {
        render('Could not refresh the items.')
      }
    },
  }
}
