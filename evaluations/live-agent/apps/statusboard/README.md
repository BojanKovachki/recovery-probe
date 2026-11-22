# Status board

The operations team's board: the health of each service, the signed-in account's notifications, and a "Sync now" button that refreshes every service's state from the upstream status service.

```bash
npm start   # http://127.0.0.1:4173 (PORT changes it)
npm test
```

- `server.mjs` serves the page and a small JSON API. Every start loads `data/`, so a restart resets the board. `data/upstream.json` is what the upstream status service answers during a sync; `{ "error": "timeout" }` means it does not answer for that service.
- `public/src/health.js` is the health panel, `notifications.js` the notifications panel, `sync.js` the sync button, `retry.js` the retry helper and `api.js` the client.
- Product requirements are in `docs/REQUIREMENTS.md`.

API:

| Request | Answer |
| --- | --- |
| `GET /api/account` | the signed-in account |
| `GET /api/services` | every service and its state |
| `GET /api/notifications` | the signed-in account's notifications |
| `POST /api/sync` | `{ syncedAt, updated: [ids], failed: [ids] }` |

Playwright and its Chromium are installed for driving the page in scripts.
