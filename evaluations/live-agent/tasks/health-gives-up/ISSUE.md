# Service health panel gives up during incidents

Reported after yesterday's API incident review.

For about ten seconds, the health endpoint answered 503 while the API restarted. The **Service health** panel showed "Service health unavailable" within a couple of seconds and stayed that way. The services only came back after someone pressed Retry, long after the API had recovered. During an incident the board is exactly what people watch, so it should come back on its own.

Expected: HLT-2 in `docs/REQUIREMENTS.md`. A failed health read is retried automatically up to three times, after 1, 2 and 4 seconds, and the panel shows the services as soon as a retry succeeds.
