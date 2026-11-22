# Orders disappear when Refresh fails

Reported by the warehouse floor lead.

When the warehouse Wi-Fi drops for a moment and someone presses **Refresh**, the whole order list disappears and only the error message is left. The pickers then can't see which orders they were working on until the connection is back and they refresh again.

Expected: the requirement in ORD-3 (`docs/REQUIREMENTS.md`). A failed refresh keeps the orders already on screen and shows "Could not refresh orders.".

Steps:
1. Open **Orders** and wait for the orders to load.
2. Make the next refresh fail (for example, stop the server for a moment).
3. Press Refresh.
