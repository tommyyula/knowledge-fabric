# External Knowledge Query MCP

The remote Streamable HTTP MCP endpoint is `POST /api/v1/mcp`. The deployment gateway must validate the Bearer JWT before it reaches Knowledge Fabric; the service maps `data.tenant_id` and `data.user_id` to the caller scope. Do not send caller-selected tenant or user headers.

Start with JSON-RPC `initialize`; the response returns `Mcp-Session-Id`. Send that header and the same Bearer token on later requests, then send the `notifications/initialized` notification. The endpoint supports only these tools:

- `knowledge_base_search`: optional `q`, `cursor`, and `limit` (1–100). It returns the same query-ready catalog page as `GET /api/v1/knowledge-bases`.
- `knowledge_base_query`: required `knowledgeBaseId`, `message`, and caller-generated `requestId`; optional server-issued `conversationId` and `newConversation`. `requestId` is the 24-hour idempotency key. The structured result contains `conversationId` and `answer`, or `status: in_progress` with stream recovery data and exact retry arguments.

Tool errors have `isError: true` and structured `code`/`status` fields. The possible public codes are `knowledge_base_not_found`, `knowledge_base_not_query_ready`, `conversation_not_found`, `idempotency_key_reused`, and `query_execution_failed`.

Only knowledge bases in `maintenance/ready` are query-ready. The server rechecks that state before starting a query, and the conversation ID is an existing scoped session rather than a model-provider session ID. External conversations are retained outside the default workbench session list for later dedicated presentation.

## Conversation continuity and retry

Within one live MCP session, `knowledge_base_query` remembers the most recent server-issued conversation for each Knowledge Base. For a later new question, omit `conversationId`, supply a new `requestId`, and the tool continues that conversation automatically. Set `newConversation: true` only when an independent conversation is intended.

`conversationId` and `requestId` have different meanings. A conversation ID is a server-issued UUID; a request ID is only an idempotency key. When a query returns `in_progress`, retry using the exact `retryArguments` returned by the tool, without changing the request ID or adding a conversation ID that was absent from the original query. After an MCP reconnect, the in-memory convenience mapping is gone; use the UUID shown in the previous completed result to continue the durable conversation.

## Operations notes

Catalog and query invocations are recorded in the `external_access_audit_events` table with scope, protocol, request correlation, outcome, transport status, duration, and an idempotency-key hash. Tokens, prompts, answers, and workspace paths are never recorded. Events carry a 180-day expiry timestamp. There is deliberately no operator UI, scheduled cleanup, or retention job in v1; retention cleanup is a manual operation (delete records whose `expires_at` is in the past). When no `DATABASE_URL` is configured, the development fallback stores the same records in `data/ontology-store.json` under `externalAccessAuditEvents`.

If the catalog projection needs repair, run `pnpm tsx scripts/rebuild-query-readiness.ts` in the deployed service environment. This rebuild is manual; the query operation still rechecks authoritative workspace state.

## Deferred in v1

- Query-only agent execution isolation and output projection.
- Rate or concurrency controls.
- Browser-direct CORS policy.
- API-key lifecycle management.
- Roles, sharing, and per-knowledge-base ACLs.
