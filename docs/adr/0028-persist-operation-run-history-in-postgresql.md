---
status: accepted
---

# Persist Operation Run history in PostgreSQL

When `DATABASE_URL` is configured, PostgreSQL is the authoritative store for structured Operation Runs, their progress logs, and Operation Artifact metadata. They are normalized into `ontology_operation_runs`, `ontology_operation_logs`, and `ontology_operation_artifacts`, explicitly scoped by tenant and owner, and correlated one-to-one with the initiating Agent Run. The Operation tables deliberately have no foreign keys to each other, the Knowledge Base, or its Conversation. Repository services explicitly delete Operation logs, artifact metadata, and runs in the same PostgreSQL transaction as the owning Operation, Conversation, or Knowledge Base deletion; any database failure rolls the whole deletion back. Every successful `operation_start` creates a user-visible Operation Run; prompt prefixes do not determine visibility. A configured deployment fails the Operation record write when PostgreSQL is unavailable instead of silently falling back and splitting history; when no database is configured, the existing workspace JSON repository remains the development fallback. Existing JSON history is not migrated.

Operation Artifact contents and Markdown reports remain in the shared, persistent Knowledge Base workspace, with PostgreSQL storing their metadata and paths. Artifact directories are created lazily. Operation Runs transition from `running` to `succeeded`, `failed`, or `cancelled`; a terminating Agent Run fails any still-running Operation rather than inventing a successful business result. The stored request is the server-held, user-visible message instead of an Agent-supplied paraphrase. History supports server-side search and stable cursor pagination, and only its display title remains editable after creation.

Database deletion is authoritative; file cleanup is best-effort because PostgreSQL and the workspace filesystem cannot share one atomic transaction. This slice adds no orphan reconciliation or retry queue. This keeps arbitrary generated files out of database backups while preserving queryable, concurrency-safe Operation history.

## Deferred

- Preventing an `operation_start` from racing with Conversation or Knowledge Base deletion.
- Cancelling all active Agent Runs before deleting a Knowledge Base.
- Bringing Conversation-level associated deletion in the JSON development fallback to parity with PostgreSQL.
- Serializing an individual Operation deletion against concurrent log, finish, and rename writes.
