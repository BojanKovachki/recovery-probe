const LABELS = { new: 'New', packed: 'Packed', shipped: 'Shipped' }

const euros = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
})

export const statusLabel = (status) => LABELS[status] ?? status

export const money = (amount) => euros.format(amount)

/** "2 Nov, 09:15" in the viewer's time zone. */
export function updatedAt(iso) {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
