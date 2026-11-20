async function request(path, options) {
  const response = await fetch(path, options)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`)
  return response.json()
}

/** The orders with the given status, or every order when `status` is empty. */
export function listOrders(status = '') {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return request(`/api/orders${query}`)
}

/** Sets an order's status on the server; resolves with the updated order. */
export function updateStatus(id, status) {
  return request(`/api/orders/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}
