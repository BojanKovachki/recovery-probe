# Dispatch console

The warehouse team's console. It opens on an overview; the Orders view (`#/orders`) lists the orders, filters them by status, and marks packed orders as shipped.

```bash
npm start   # http://127.0.0.1:4173 (PORT changes it)
npm test
```

- `server.mjs` serves the page and a small JSON API. Every start loads `data/orders.json`, so a restart resets the data.
- `public/src/store.js` holds the screen's state, `view.js` draws it, `api.js` talks to the server and `main.js` wires them together.
- Product requirements are in `docs/REQUIREMENTS.md`.

API:

| Request | Answer |
| --- | --- |
| `GET /api/orders` | every order (slow: it scans the whole table) |
| `GET /api/orders?status=packed` | the orders with that status |
| `POST /api/orders/:id/status` with `{ "status": "shipped" }` | the updated order |

Playwright and its Chromium are installed for driving the page in scripts.
