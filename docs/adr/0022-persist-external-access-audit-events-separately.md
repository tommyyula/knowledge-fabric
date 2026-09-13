# Persist external access audit events separately

External catalog and query calls are recorded in a dedicated persistent audit store: PostgreSQL in production and the existing local persistent-memory fallback in development. Records contain time, request, protocol, operation, scope IDs, outcome, stable error code, transport status, duration, and a hash of the idempotency key; they never contain bearer tokens, prompts, answers, or workspace paths. Events are retained for 180 days and are removed by manual operations rather than a newly introduced scheduled cleanup mechanism.
