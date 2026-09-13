# External Knowledge Query A2A

Knowledge Fabric exposes one deployment-level A2A 1.0 Remote Agent. It is a server only: it accepts A2A requests but does not call other A2A agents.

- Agent Card: `GET /.well-known/agent-card.json`
- HTTP+JSON interface: `/api/v1/a2a`
- Binding/version: `HTTP+JSON`, A2A `1.0` only
- Authentication: gateway-validated `Authorization: Bearer <JWT>` on every operation
- Required service header: `A2A-Version: 1.0`
- Message content type: `application/a2a+json`

The gateway JWT supplies the tenant and user scope. Caller-selected tenant or user headers do not grant access. The Agent Card is public but contains no caller or Knowledge Base data. JSON-RPC, gRPC, A2A v0.3, outbound A2A calls, and Push Notifications are not supported.

## Discover Query-ready Knowledge Bases

Send `POST /api/v1/a2a/message:send` with exactly one operation Data Part. A2A discovery does not text-filter the catalog. `cursor` and `limit` are optional; `limit` is between 1 and 100.

```json
{
  "message": {
    "messageId": "catalog-request-1",
    "role": "ROLE_USER",
    "parts": [{
      "data": { "operation": "knowledge_base_search", "limit": 20 },
      "mediaType": "application/json"
    }]
  }
}
```

Discovery returns a direct A2A `message`, not a Task. Its Data Part contains `items` and an opaque `nextCursor`. Every item is owned by the authenticated caller and is Query-ready.

## Create an A2A Query Task

Send one `knowledge_base_query` Data Part and one non-empty Text Part. `knowledgeBaseId` is always explicit; the server never infers it from the question. The client-created `messageId` is the 24-hour idempotency key.

```json
{
  "message": {
    "messageId": "query-018f4b",
    "role": "ROLE_USER",
    "parts": [
      {
        "data": { "operation": "knowledge_base_query", "knowledgeBaseId": "kb-123" },
        "mediaType": "application/json"
      },
      { "text": "What is the release process?", "mediaType": "text/plain" }
    ]
  }
}
```

An accepted query always returns `task`. Omitting `contextId` creates an External Conversation; the returned Task `contextId` is its server-issued `conversationId`. Supply that value with a new `messageId` to continue the same Knowledge Base conversation. A context cannot be moved to another principal or Knowledge Base, and only one non-terminal Task may run in a context.

An identical `messageId` retry returns the original Task. Reusing it with a different operation, target, supplied context, question, or attachment set returns HTTP 409.

The Task progresses through `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`, and a terminal state. A successful Task contains one `knowledge-answer` Artifact. Internal tool calls, provider details, workspace paths, and raw Run events are not exposed.

## Poll, list, stream, and cancel

- Poll: `GET /api/v1/a2a/tasks/{taskId}`
- List the caller's Tasks: `GET /api/v1/a2a/tasks`
- Stream a new query: `POST /api/v1/a2a/message:stream`
- Subscribe to an existing Task: `GET /api/v1/a2a/tasks/{taskId}:subscribe`
- Cancel: `POST /api/v1/a2a/tasks/{taskId}:cancel`

Streaming uses SSE and emits only A2A Task, status, and answer Artifact updates. Disconnecting the transport does not cancel the query; poll the returned Task ID to recover. Cancellation is idempotent after the Task reaches `TASK_STATE_CANCELED` and aborts active internal HTTP work when possible.

Tasks are scoped to the gateway principal and retained for 24 hours. Expired or out-of-scope IDs return task-not-found. After restart, a saved underlying answer repairs an interrupted Task to completed; otherwise it becomes failed with `service_interrupted` and is not automatically re-executed.

## Inline Query Attachments

An A2A query may contain up to 10 inline `raw` File Parts. Bytes use Base64 JSON encoding. Each decoded file and the decoded aggregate must be at most 50 MB; files must be non-empty and have safe leaf filenames. Any declared media type is accepted as untrusted metadata.

```json
{
  "raw": "SGVsbG8sIHdvcmxkIQ==",
  "filename": "notes.txt",
  "mediaType": "text/plain"
}
```

Attachments are accepted but **not processed** in this release. They do not influence the answer. The Task and Artifact return metadata receipts (`name`, `mediaType`, `size`, `sha256`, `processed:false`) and `attachmentsProcessed:false`. Raw bytes are staged in an isolated Task directory and removed on completion, failure, cancellation, or restart. They never enter the Resource Library, Knowledge Base workspace, ingestion flow, audit log, or Task Store.

Remote `url` File Parts, archive extraction, URI fetching, persistence, content parsing, malware scanning, content-type allowlists, pre-signed uploads, and attachment-specific storage quotas are deferred.

## Errors and operations

Admission failures return an A2A HTTP error and create no Task. Common conditions include invalid input (400), missing or out-of-scope resources (404), idempotency/concurrency conflicts (409), and failed execution represented by a terminal failed Task after admission.

A2A catalog and query execution reuse the existing external REST boundary. Audit events identify protocol `a2a` and retain scope, operation, outcome, status, duration, correlation, and hashed idempotency data—never credentials, questions, answers, attachment bytes, or workspace paths. Existing REST and remote MCP contracts remain unchanged.
