import { money, statusLabel, updatedAt } from './format.js'

function cell(className, text) {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text
  return span
}

function row(order, onShip) {
  const item = document.createElement('li')
  item.dataset.order = order.id
  item.append(
    cell('id', order.id),
    cell('customer', order.customer),
    cell('state', statusLabel(order.status)),
    cell('total', money(order.total)),
    cell('updated', updatedAt(order.updatedAt)),
  )
  if (order.status === 'packed') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ship'
    button.textContent = 'Mark shipped'
    button.addEventListener('click', () => onShip(order.id))
    item.append(button)
  }
  return item
}

/** Draws the orders screen for `state` into the elements of `screen`. */
export function render(screen, state, { onShip }) {
  screen.status.textContent = state.loading
    ? state.loaded
      ? 'Refreshing…'
      : 'Loading orders…'
    : ''
  screen.error.textContent = state.error ?? ''
  screen.error.hidden = !state.error
  screen.empty.hidden =
    state.loading || !state.loaded || state.orders.length > 0
  screen.list.replaceChildren(
    ...state.orders.map((order) => row(order, onShip)),
  )
  for (const button of screen.filters)
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.filter === state.filter),
    )
}
