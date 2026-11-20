import { createStore } from './store.js'
import { render } from './view.js'

const screen = {
  status: document.querySelector('#status'),
  error: document.querySelector('#error'),
  empty: document.querySelector('#empty'),
  list: document.querySelector('#orders'),
  filters: [...document.querySelectorAll('[data-filter]')],
}
const views = {
  overview: document.querySelector('#overview'),
  orders: document.querySelector('#orders-view'),
}

const store = createStore()
store.subscribe((state) => render(screen, state, { onShip: store.ship }))
render(screen, store.state, { onShip: store.ship })

for (const button of screen.filters)
  button.addEventListener('click', () => store.load(button.dataset.filter))
document
  .querySelector('#refresh')
  .addEventListener('click', () => store.refresh())

/** Shows the view the address names; opening Orders loads them. */
function route() {
  const orders = location.hash === '#/orders'
  views.overview.hidden = orders
  views.orders.hidden = !orders
  if (orders) store.load(store.state.filter)
}
window.addEventListener('hashchange', route)
route()
