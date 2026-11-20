# Status board requirements

- **HLT-1** The service health panel lists every service with its state (Operational, Degraded or Outage).
- **HLT-2** A failed health read is retried automatically up to three times, after 1, 2 and 4 seconds. When a retry succeeds, the panel shows the services. After the last failure it shows "Service health unavailable" with a Retry button, which starts again.
- **NTF-1** The notifications panel lists the signed-in account's notifications, newest first.
- **NTF-2** An account with no notifications sees "You're all caught up". A failed read shows "Could not load notifications." with a Retry button, never the empty message.
- **SYN-1** "Sync now" asks the upstream status service for every service's current state, then shows "Last synced at HH:MM" and the services' states.
