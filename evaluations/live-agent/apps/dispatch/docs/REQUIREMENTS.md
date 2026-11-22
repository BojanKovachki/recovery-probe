# Dispatch console requirements

- **ORD-1** The Orders view lists the orders for the selected filter: it shows each order with its id, customer, status, total and last update.
- **ORD-2** The filters (All, New, Packed, Shipped) show only the orders with that status. The list always matches the filter selected last, however quickly the filters are changed.
- **ORD-3** Refresh reloads the list for the selected filter. If a refresh fails, the orders already shown stay on screen and the message "Could not refresh orders." is shown. The next successful refresh removes the message.
- **ORD-4** "Mark shipped" on a packed order sets its status to shipped on the server. Once the server confirms, the row shows "Shipped" without a reload. If the update fails, the row keeps its status and "Could not update the order." is shown.
- **ORD-5** While the first load runs, the screen says "Loading orders…". If the first load fails, it says "Could not load orders." and Refresh tries again.
