# Wrong orders under a filter after switching quickly

Reported by two dispatchers this week; it started after the filter tabs were added.

When I open **Orders** and quickly click **Shipped**, I sometimes see new and packed orders in the list, although the Shipped tab is selected. It doesn't happen every time; it seems to happen more right after Orders opens. Clicking Shipped again fixes the list.

Expected: ORD-2 in `docs/REQUIREMENTS.md`. The list always matches the filter selected last, however quickly the filters are changed.
