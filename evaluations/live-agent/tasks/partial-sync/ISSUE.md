# Sync leaves a mix of old and new statuses

Reported by the on-call engineer.

When I press **Sync now** while the upstream status service is slow, it times out for some services. The board then shows the new state for some services and the old state for others, and still says "Last synced at …". Nothing tells you which services are out of date, so during an incident you can't trust the board.

Please fix sync so the board can be trusted after a sync.

Relevant requirement: SYN-1 in `docs/REQUIREMENTS.md`.
