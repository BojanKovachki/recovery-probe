import * as ordersApi from './api.js'

/** The orders screen's state. Views subscribe and re-render when it changes. */
export function createStore(api = ordersApi) {
  let state = {
    orders: [],
    filter: '',
    loading: true,
    loaded: false,
    error: null,
  }
  let latestLoad = 0
  const listeners = new Set()

  function set(changes) {
    const next = { ...state, ...changes }
    // Views re-render only when something they show changed.
    if (Object.keys(changes).every((key) => next[key] === state[key])) return
    state = next
    for (const listener of listeners) listener(state)
  }

  async function load(filter = state.filter) {
    const request = ++latestLoad
    // Another filter is another list: the old rows must not show under it.
    set({
      filter,
      loading: true,
      ...(filter === state.filter ? {} : { orders: [] }),
    })
    try {
      const orders = await api.listOrders(filter)
      // A newer load started while this one was on its way: its answer wins.
      if (request !== latestLoad) return
      set({ orders, loading: false, loaded: true, error: null })
    } catch {
      if (request !== latestLoad) return
      set({
        orders: [],
        loading: false,
        error: state.loaded
          ? 'Could not refresh orders.'
          : 'Could not load orders.',
      })
    }
  }

  async function ship(id) {
    try {
      const updated = await api.updateStatus(id, 'shipped')
      set({
        orders: state.orders.map((order) =>
          order.id === updated.id ? updated : order,
        ),
        error: null,
      })
    } catch {
      set({ error: 'Could not update the order.' })
    }
  }

  return {
    get state() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    refresh: () => load(),
    ship,
  }
}
