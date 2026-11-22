import { clock, newestFirst } from './format.js'

function notificationRow(notification) {
  const item = document.createElement('li')
  item.dataset.notification = notification.id
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = notification.title
  const time = document.createElement('time')
  time.dateTime = notification.createdAt
  time.textContent = clock(notification.createdAt)
  item.append(title, time)
  return item
}

/** The notifications panel for the signed-in account. */
export function createNotifications(panel, api) {
  async function load() {
    panel.error.hidden = true
    panel.empty.hidden = true
    try {
      const notifications = await api.listNotifications()
      panel.list.replaceChildren(
        ...newestFirst(notifications).map(notificationRow),
      )
      panel.empty.hidden = notifications.length > 0
    } catch {
      panel.list.replaceChildren()
      panel.error.hidden = false
    }
  }
  panel.retry.addEventListener('click', load)
  return { load }
}
