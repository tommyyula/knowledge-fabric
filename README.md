# Knowledge Fabric

Knowledge Fabric is a Vite React app plus a TypeScript Node/Express backend for creating, verifying, reviewing, sharing, querying, and maintaining Claude-powered knowledge bases. Each knowledge base owns a file-system workspace seeded from `server/templates/knowledge-base`; Claude works inside that workspace through project instructions, skills, runtime tools, and backend-enforced review gates. The app also includes a Resource Library, Bitbucket-backed source references, external knowledge query APIs, MCP/A2A adapters, Operation Run history, and AI Video SOP generation.

## Run

Use `pnpm@10.32.1`.

```bash
pnpm install
pnpm dev:server
pnpm dev:frontend
```

- `pnpm dev` starts frontend and backend together.
- Frontend: http://localhost:8888
- Backend: http://localhost:8787
- Health check: `GET /healthz`

Production-style local serving is split in the same way:

```bash
pnpm build
pnpm start:server
pnpm start:frontend
```

`start:frontend` serves `dist/` on `STATIC_PORT` (default `8888`) and proxies API traffic to `STATIC_API_TARGET` (default `http://127.0.0.1:8787`).

## Environment

The backend loads `.env`, `.env.local`, and `.env.private` from the current working directory before reading configuration. Vite exposes only `VITE_*` variables to the browser.

### Server and storage

- `PORT` / `ONTOLOGY_SERVER_PORT` choose the backend port; default `8787`.
- `APP_DATA_ROOT` / `ONTOLOGY_DATA_ROOT` choose the data root; default `/app/data`. For repo-local development, set `APP_DATA_ROOT=data`.
- `DATABASE_URL` is optional. When present, Postgres stores projects, sessions, shares, access audit records, external query idempotency, and eligible Operation Runs. When absent, the backend uses a JSON-backed development repository at the data root while still creating real workspace directories.
- `ONTOLOGY_WORKSPACE_ROOT` defaults to `${APP_DATA_ROOT}/ontology-workspaces`.
- `ONTOLOGY_INITIAL_WIKI_SOURCE` defaults to `server/templates/knowledge-base` and is forked directly into each knowledge-base workspace root, so `CLAUDE.md` sits at the Claude SDK `cwd`.
- `RESOURCE_LIBRARY_ROOT` / `ONTOLOGY_RESOURCE_LIBRARY_ROOT` default to `${APP_DATA_ROOT}/resource-library`.
- `CLAUDE_CONFIG_ROOT` defaults to `${APP_DATA_ROOT}/.claude`; `CLAUDE_SESSION_STORE_ROOT` defaults to `${APP_DATA_ROOT}/claude-session-store`.
- `CLAUDE_SESSION_STORE=postgres` stores Claude session mappings in Postgres; otherwise the file store is used.
- `JSON_BODY_LIMIT` defaults to `90mb`.
- `ONTOLOGY_MAX_UPLOAD_BYTES` controls single multipart upload size before conversion; default `500 MiB`.

#### Local Postgres for development

`docker-compose.dev.yml` starts a throwaway Postgres 16 for development only; it is
excluded from the production build context and is not referenced by the `Dockerfile`.

```bash
pnpm db:up      # docker compose -f docker-compose.dev.yml up -d --wait db
pnpm dev:server
pnpm db:down    # stop the container, keep the volume
```

Then enable the matching connection string in one env file (`.env`, `.env.local`, or
`.env.private`):

```
DATABASE_URL=postgresql://ontology:ontology@127.0.0.1:55432/ontology
DATABASE_SSL=disable
```

- **Start the database before the server.** With `DATABASE_URL` set and the container
  down, `preflightDatabase()` exhausts every SSL mode and throws, the process exits, and
  `tsx watch` keeps restarting into the same failure. There is **no** fallback to the JSON
  store in that case. To run without Postgres, comment the `DATABASE_URL` line out
  entirely rather than leaving an unreachable value.
- **Existing JSON data is not migrated.** Snapshots written to
  `${workspaceRoot}/../ontology-store.json` stay on disk but are not imported (see
  `docs/adr/0028-persist-operation-run-history-in-postgresql.md`), so the knowledge-base
  list starts empty after the switch. No import tool exists yet; open an issue if one is
  needed.
- **Expect one scary-looking log line.** `DATABASE_SSL` defaults to `auto`, which tries
  encrypted first and then plaintext:

  ```
  [db] connect failed host=127.0.0.1 port=55432 db=ontology user=ontology ssl=on (certificate not verified): The server does not support SSL connections
  [db] connected host=127.0.0.1 port=55432 db=ontology user=ontology ssl=off (plaintext) (DATABASE_SSL=auto)
  ```

  The first line is the probe, not a misconfiguration. With `DATABASE_SSL=disable` only
  the `connected ... ssl=off (plaintext)` line remains.

- **Env files are first-one-wins**, both across `.env` → `.env.local` → `.env.private`
  **and line by line inside a single file**; a defined empty string also counts as set.
  `DATABASE_URL` and `DATABASE_SSL` must therefore take effect exactly once. If you enable
  the local example in `.env.example`, comment out the deployment `DATABASE_URL=` /
  `DATABASE_SSL=` lines above it instead of adding a second pair.
- **Tests unlocked by `DATABASE_URL`**: 16 cases across two files —
  `scripts/operation-run-store-postgres.test.mts` (12) and
  `scripts/operation-run-associated-deletion-postgres.test.mts` (4). The single case in
  `scripts/technical-issue-reports-postgres.test.mts` is gated on
  `RUN_SUPPORT_REPORT_POSTGRES_TEST=true`, not on `DATABASE_URL`. These tests delete rows
  and drop triggers in the configured database (scoped by tenant, but still destructive),
  so never point `DATABASE_URL` at a shared database with real data. On disk they leave
  nothing behind: both files create their own workspace roots under the OS temp directory
  (the associated-deletion file also overrides `APP_DATA_ROOT` with one before importing any
  server module) and remove them when the test run ends.
- **Host port** defaults to `55432` to avoid clashing with a Postgres already listening on
  `5432`. Override it with `DB_HOST_PORT`, which must be set in the project-root `.env` —
  `docker compose` reads only `.env` for interpolation, never `.env.local` or
  `.env.private` — and update the port inside `DATABASE_URL` to match.
- **`--wait` needs Docker Compose v2.17+.** On older versions `pnpm db:up` returns before
  the container is healthy, which lands you back in the first bullet; confirm readiness
  with `docker compose -f docker-compose.dev.yml exec db pg_isready -U ontology` before
  starting the server.
- **Reset a broken database** with `docker compose -f docker-compose.dev.yml down -v`. That
  removes the named volume, so the next `pnpm db:up` yields an empty database and
  `ensureMigrations()` runs from scratch — useful after a half-applied migration.
- **Scope**: Postgres holds projects, sessions, shares, audit records, external query
  idempotency, and eligible Operation Runs. Claude session mappings stay in the file store
  unless `CLAUDE_SESSION_STORE=postgres`, and the Resource Library and workspaces remain on
  disk either way. The `database` field of `/healthz` is just `Boolean(env.databaseUrl)`
  and performs no liveness probe — its value comes from the fact that a failed preflight
  stops the process outright.

### Auth, IAM, and frontend

- `ONTOLOGY_IAM_ENABLED=true` enables strict IAM headers and SSO-backed user resolution. Development mode falls back to `dev-user` / `dev-tenant`.
- `VITE_IAM_ENABLED=true` enables the frontend IAM experience. If `ONTOLOGY_IAM_ENABLED` is unset, the backend also treats `VITE_IAM_ENABLED=true` as IAM enabled.
- `SSO_URL` / `VITE_SSO_URL`, `SSO_TOKEN_URL`, `IAM_CLIENT_ID` / `SSO_CLIENT_ID` / `VITE_SSO_CLIENT_ID`, and `IAM_CLIENT_SECRET` / `SSO_CLIENT_SECRET` configure SSO token exchange and tenant switching.
- `VITE_API_BASE_URL` overrides the browser API base URL. Leave it empty when Vite proxies or same-origin serving handles API routes.
- `VITE_DEV_TENANT_ID` defaults to `dev-tenant` in non-IAM mode; `VITE_IAM_APP_CODE` defaults to `knowledge_fabric`.
- `ONTOLOGY_ADMIN_USER_IDS` is a comma-separated server-only admin allowlist for admin data access.
- `APP_URL` / `VITE_APP_URL` are used for public callback/open URLs, including Composio and A2A agent cards.
- `VITE_ENABLE_MOCK_FALLBACK=true` re-enables fixture fallback for older prototype flows. Keep it off for normal backend-backed development.
- `VITE_APP_RELEASE` labels client-generated troubleshooting reports; `APP_RELEASE` labels server-generated reports.

### Claude, proxy, and AI extraction

- `ONTOLOGY_ENABLE_CLAUDE=true` enables the real Claude Agent SDK adapter. It runs in the knowledge-base workspace with workspace-scoped project settings and tools including `Agent`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `Bash`, `LSP`, and workspace-scoped MCP tools. Leave it false for deterministic local fallback smoke tests.
- `ONTOLOGY_CLAUDE_INHERIT_LOCAL_AUTH=false` prevents inheriting local Claude auth files into the isolated `CLAUDE_CONFIG_DIR`.
- `ONTOLOGY_PROXY_PROVIDER` / `ONTOLOGY_PROXY_MODEL` route Claude Agent SDK through the Agent Factory-style Anthropic-to-Azure/OpenAI proxy. Local `.env.local` commonly uses `azure` / `gpt-5.4`.
- `ONTOLOGY_PROXY_BASE_URL`, `ONTOLOGY_PROXY_TOKEN`, and `ONTOLOGY_PROXY_ALLOW_UNAUTHENTICATED` control the internal Anthropic-compatible proxy mounted at `/api/proxy`.
- `OPENAI_API_KEY` / `OPENAI_CHAT_COMPLETIONS_URL` configure the OpenAI provider path when selected.
- `MARKITDOWN_ENABLED=false` disables the external MarkItDown converter for Office/PDF/image-like inputs. `MARKITDOWN_PYTHON` selects the Python executable; by default the server uses `.venv-markitdown/bin/python` when present, otherwise `python3`.
- `MARKITDOWN_LLM_MODEL`, `MARKITDOWN_LLM_API_KEY`, and `MARKITDOWN_LLM_BASE_URL` opt MarkItDown into LLM-backed conversion. Global OpenAI/Azure env is hidden from MarkItDown unless `MARKITDOWN_ALLOW_GLOBAL_LLM_ENV=true`.
- `VISION_EXTRACTION_ENABLED=false` disables image/diagram extraction. `VISION_EXTRACTION_PROVIDER`, `VISION_EXTRACTION_MODEL`, `VISION_EXTRACTION_API_KEY`, `VISION_EXTRACTION_BASE_URL`, `VISION_EXTRACTION_CHAT_COMPLETIONS_URL`, and `VISION_EXTRACTION_TIMEOUT_MS` tune the vision path for standalone images, PDF pages, and embedded Office images.

### Integrations and support

- `COMPOSIO_API_KEY` enables Composio app connections. `COMPOSIO_CALLBACK_BASE_URL` controls OAuth callback origin; `COMPOSIO_AUTH_CONFIG_<APP>` pins an auth config for a supported app.
- `BITBUCKET_API_BASE_URL` defaults to `https://api.bitbucket.org/2.0`; `BITBUCKET_GIT_BASE_URL` defaults to `https://bitbucket.org`.
- `A2A_PUBLIC_BASE_URL` / `APP_URL` controls the public base URL advertised by `/.well-known/agent-card.json`; `A2A_QUERY_START_DELAY_MS` can delay A2A query starts for tests.
- `DASHSCOPE_API_KEY` enables real AI Video SOP processing. When absent, the AI Video to SOP entry remains visible but cannot submit jobs; there is no mock fallback.
- `DASHSCOPE_BASE_URL` defaults to `https://dashscope-us.aliyuncs.com/compatible-mode/v1`. `DASHSCOPE_VL_MODEL` and `DASHSCOPE_SOP_MODEL` both default to `qwen3.7-plus`.
- `VIDEO_SOP_MAX_VIDEOS`, `VIDEO_SOP_MAX_FILE_BYTES`, and `VIDEO_SOP_MAX_CONCURRENT_JOBS` default to `4`, `7340032` (7 MiB per recording), and `2` respectively.
- `VIDEO_SOP_ANALYSIS_TIMEOUT_MS` and `VIDEO_SOP_GENERATION_TIMEOUT_MS` default to 30 minutes and 10 minutes. Source recordings are temporary job inputs; only the generated Markdown SOP Resource is retained in the Resource Library.
- `SUPPORT_EMAIL_API_URL` configures Technical Issue Report, share invitation, and notification email delivery; it defaults to the marketplace staging notification service.
- `SUPPORT_REPORT_RECIPIENTS` is a comma-separated, server-only issue report recipient list and defaults to `marketplace@item.com`.
- `SUPPORT_EMAIL_TIMEOUT_MS` controls the upstream email timeout and defaults to 15 seconds.

### Azure OpenAI upstream pool

Agent text completions can be distributed active-active across independently limited, model-compatible Azure OpenAI deployments. Configure the pool as a runtime secret containing JSON; do not bake real keys into examples or logs:

```env
AZURE_OPENAI_UPSTREAMS=[{"id":"azure-a","url":"https://resource-a.example/openai/v1/chat/completions","apiKey":"<secret-a>","weight":1},{"id":"azure-b","url":"https://resource-b.example/openai/v1/chat/completions","apiKey":"<secret-b>","weight":1}]
```

Each entry requires a unique non-empty `id`, an HTTP(S) `url`, a non-empty `apiKey`, and a positive numeric `weight`. Invalid explicit pool configuration prevents server startup. When `AZURE_OPENAI_UPSTREAMS` is absent, `AZURE_OPENAI_CHAT_COMPLETIONS_URL` plus `AZURE_OPENAI_API_KEY` continue to define one legacy upstream; when all Azure variables are absent, the server starts with Azure routing disabled. Configuration changes require a process restart.

The pool selects by in-flight requests normalized by weight, with smooth weighted round-robin tie-breaking. A request tries at most two distinct upstreams by default (`AZURE_OPENAI_MAX_ATTEMPTS`). It may fail over on network failures, HTTP 408/409/429/5xx, and upstream-specific 401/403/404 responses, but only before the first translatable text or tool-call event. Once visible SSE output begins, failures terminate that stream and are never replayed.

Timeout controls default to 15 seconds for connection/response headers (`AZURE_OPENAI_CONNECT_TIMEOUT_MS`), 120 seconds for first content (`AZURE_OPENAI_FIRST_CONTENT_TIMEOUT_MS`), and 120 seconds of stream inactivity (`AZURE_OPENAI_STREAM_IDLE_TIMEOUT_MS`). There is no absolute duration limit for an active stream. `AZURE_OPENAI_PRECOMMIT_BUFFER_BYTES` bounds buffered pre-content SSE data and defaults to 256 KiB.

Cooling defaults are configurable through `AZURE_OPENAI_TRANSIENT_BASE_COOLDOWN_MS`, `AZURE_OPENAI_TRANSIENT_MAX_COOLDOWN_MS`, `AZURE_OPENAI_RATE_LIMIT_BASE_COOLDOWN_MS`, `AZURE_OPENAI_RATE_LIMIT_MAX_COOLDOWN_MS`, `AZURE_OPENAI_CONFIGURATION_BASE_COOLDOWN_MS`, `AZURE_OPENAI_CONFIGURATION_MAX_COOLDOWN_MS`, and `AZURE_OPENAI_COOLDOWN_JITTER_RATIO`. HTTP 429 uses Azure `retry-after-ms` first, then standard `Retry-After`, then exponential backoff with jitter. Circuit and load state are process-local; the proxy provides no local queue, concurrency cap, or TPM/RPM token bucket.

The pool is used by the Anthropic-to-Azure proxy and direct Agent text completions only. The OpenAI provider and vision extraction retain their independent configuration and do not use this pool.

## Backend Shape

- `POST /api/v1/ontologies` creates a tenant-scoped knowledge base, default session, a workspace forked from the managed template, `raw/`, `sources/`, and `.runtime/journey-state.json`.
- `/api/v1/ontologies` owns knowledge-base profile CRUD, soft deletion, tombstone preferences, template sync, sharing/invitations, change logs, journey state, pending reviews, approve/discard/recover actions, and review-to-ontology sync.
- `/api/v1/ontologies/:id/tree`, `/files`, `/raw`, `/graph`, and `/ontology-graph` expose safe workspace reads, source uploads/conversion, and generated graph artifacts.
- `/api/v1/ontologies/:id/sessions` owns conversations, persisted messages, public conversation snapshots, cancellation, live run status, AI SDK UI streams, follow-up suggestions, and `OntologyStreamEvent` SSE frames.
- `/api/v1/resource-library` owns user resources, folders, downloads/previews, resource bindings, Bitbucket credentials, repository references, cached repository files, and checkout refresh.
- `/api/v1/video-sop` owns AI Video SOP capabilities, queued jobs, generated SOP resources, cancellation, and cleanup.
- `/api/v1/operations` lists, renames, and deletes completed Operation Runs across accessible knowledge bases.
- `/api/v1/knowledge-bases` and `/api/v1/knowledge-bases/:id/queries` expose query-ready knowledge bases to external REST callers with idempotency and access audit records.
- `/api/v1/mcp`, `/.well-known/agent-card.json`, and `/api/v1/a2a` adapt the external query surface to MCP and A2A.
- `/api/auth` handles IAM token exchange, tenant switching, and current-user lookup.
- `/api/composio` handles supported Composio app discovery, connect/disconnect, and OAuth callback activation.
- `/api/proxy` exposes the internal Anthropic-compatible proxy used by the Claude Agent SDK adapter.

Path access rejects absolute paths and `..` escapes.

## Workspace Layout

Each knowledge-base workspace is the source of truth for Claude and the UI:

- `CLAUDE.md`, `AGENTS.md`, `BOOTSTRAP.md`: top-level instructions copied from `server/templates/knowledge-base`.
- `skills/` and `tools/`: Claude skills and helper scripts for bootstrap, ingest, verify, review draft edits, querying, ontology sync, operation execution, and knowledge edits.
- `raw/`: uploaded source materials. Zip uploads should preserve a stable top-level source folder such as `raw/Lenvov-IDG/...`.
- `sources/`: optional source-side workspace material managed by uploads and skills.
- `.runtime/`: journey state, workflow locks, template/schema sync records, and runtime metadata.
- `.runtime/source-files/`: original uploaded files and conversion/extraction metadata.
- `ingest-plans/`: batch ingest plans and progress records.
- `pending_review/drafts/<draft-id>/knowledge/`: staged knowledge changes waiting for Verify and Review.
- `verify/`: Verify artifacts. Only artifacts in this active workspace directory count for UI progress and Review gate decisions.
- `knowledge/`: approved knowledge content after Review is applied.
- `wiki/`: legacy content root supported for backward-compatible reads and older workspaces.
- `graph/`: generated knowledge graph and ontology graph JSON/HTML artifacts.
- `operations/`: file-backed Operation Run records when the configured store is not Postgres.

## Knowledge Journey Design

This section is intentionally detailed. The journey state coordinates frontend UI, backend gates, filesystem artifacts, Claude skills, and the `knowledge_update_journey` MCP tool. Do not change it as a single-component UI concern.

### State Model

The canonical type is `JourneyState` in `src/contracts/ontology.ts`; the persisted file is `.runtime/journey-state.json`.

`JourneyState` has two top-level routing fields:

- `flow`: `build | maintenance`
- `phase`: `bootstrap | ingest | verify | review | ready`

`flow=build` means the user is creating a new knowledge base and the right panel shows the four-step build journey:

```text
Bootstrap -> Ingest -> Verify -> Review
```

`flow=maintenance` means the knowledge base is already usable. The normal resting phase is `ready`. Maintenance workflows may still enter `review` for staged changes, but they are not the same as the initial build journey.

Each node also owns a payload:

- `bootstrap`: early setup state, source-material list, proposed schema, metadata, and `bootstrap-result.json` projection.
- `ingest`: ingest plan progress, batches, generated page list, and source-file progress.
- `verify`: QA generation, answer testing, fixes, coverage, and artifact-derived case list.
- `review`: active draft id, staged files, review status, and description.

Important naming rule: `bootstrap.status` is only for Bootstrap itself. It must not carry later workflow states like `ingesting`, `review_pending`, or `complete`. Later workflow position belongs to top-level `phase`.

### Bootstrap Node

`phase=bootstrap` covers only the setup conversation:

- `goal_selection`: waiting for the user to describe the knowledge base goal.
- `materials_collection`: waiting for source materials.
- `materials_ready`: source materials exist and Claude can inspect them.
- `schema_proposed` / `schema_confirmation`: Claude proposed the knowledge structure and is waiting for confirmation or adjustment.
- `metadata_proposed` / `metadata_confirmation`: Claude proposed name, description, emoji, language, and naming conventions.
- `hydrating`: confirmed config is being materialized.
- `done`: Bootstrap is complete.

Bootstrap completion is represented by `bootstrap-result.json` plus `bootstrap.status=done`. After that, backend code hydrates managed templates from the result and injects a continuation prompt telling Claude to execute the Ingest Workflow for `raw/` without asking for another confirmation.

`BOOTSTRAP.md` may be removed after Bootstrap is complete. UI and backend logic must not use only the presence or absence of `BOOTSTRAP.md` to decide whether the build journey exists; use `JourneyState.flow` and `JourneyState.phase`.

### Ingest Node

`phase=ingest` means Claude is converting source materials into a staged draft under:

```text
pending_review/drafts/<draft-id>/knowledge/
```

`ingest.status` is intentionally simple:

- `pending`
- `in_progress`
- `completed`
- `failed`

Progress can also be projected from `ingest-plans/*.json`. Ingest does not write directly into approved `knowledge/`; it stages draft content for Verify and Review.

When Ingest has created a draft and is about to start Verify, the ingest skill should call:

```text
knowledge_update_journey(status=done, awaitingUser=false, build_phase=verify, claude_workflow=verify)
```

That call is for UI synchronization only. The real Verify work still has to create active workspace artifacts under `verify/`.

### Verify Node

`phase=verify` means generated draft knowledge is being checked against source materials before the user can review it.

`verify.status` is:

- `generating`: generating QA pairs from source materials.
- `testing`: answering QA pairs from the staged knowledge.
- `fixing`: repairing the staged draft and retesting.
- `done`: final results exist.

Verify artifacts are grouped by basename:

```text
verify/verify-<source-slug>-<YYYY-MM-DD>.json
verify/verify-<source-slug>-<YYYY-MM-DD>-questions.json
verify/verify-<source-slug>-<YYYY-MM-DD>-knowledge-answers.json
verify/verify-<source-slug>-<YYYY-MM-DD>-failed-questions.json
verify/verify-<source-slug>-<YYYY-MM-DD>-failed-knowledge-answers.json
verify/verify-<source-slug>-<YYYY-MM-DD>-results.json
```

The UI can render Verify progressively as these files appear. Questions, answers, failures, fixes, and final results should come from active workspace `verify/` artifacts.

Critical rule: artifacts inside `.claude/worktrees/...` do not count. Claude may use sub-agents, but final Verify artifacts and repairs must be written in the active ontology workspace. The verify skill enforces this boundary: the main agent runs Phase 1 and Phase 3 in the active workspace; only Phase 2 may use a sub-agent to answer the questions-only file.

### Review Gate

Review is protected by a backend gate. Claude cannot force the app into Review just by calling `knowledge_update_journey`.

To enter `phase=review`, all of these must be true:

- A pending review draft exists under `pending_review/drafts/<draft-id>/`.
- A matching Verify artifact group exists in active workspace `verify/`.
- The Verify artifact `knowledge_path` matches `pending_review/drafts/<draft-id>/knowledge`.
- A final `*-results.json` file exists.
- `verify.status=done`.
- `questionCount > 0`.
- `coverage >= 100`.
- `failCount = 0`.
- `needsInput = 0`.
- `passCount >= questionCount`.
- The draft was not modified after the latest Verify result.

If any condition fails, backend keeps the journey in `verify` and returns a clear gate reason such as `verify_missing`, `verify_in_progress`, or `verify_failed`.

There is also a short Verify-to-Review dwell period so the UI does not visually jump straight from Ingest to Review when Verify finishes quickly.

### Review Node

`phase=review` means the user is looking at staged draft content. In the initial build flow, Review shows the active draft content and lets the user approve or discard it. The approved draft is applied into `knowledge/`, and the project transitions to:

```text
flow=maintenance
phase=ready
```

While the user is already in Review, edits to the staged draft should modify the active draft in place. They should not create a nested draft, restart Ingest, or regress the journey back to Verify unless the draft changed in a way that invalidates the existing Verify result and the backend gate requires a rerun.

### Ready And Maintenance

`phase=ready` with `flow=maintenance` is the normal state after a knowledge base is built. The user can query knowledge, import new materials, edit existing knowledge, or stage maintenance changes.

Maintenance changes should still use the same principles:

- Stage changes before applying them.
- Verify knowledge-changing drafts before Review when the workflow requires source-grounded validation.
- Apply only after user approval.

### MCP Tool Semantics

`knowledge_update_journey` is a UI synchronization tool, not the source of business truth.

It may move the right-side panel to `bootstrap`, `ingest`, `verify`, `review`, or `ready`, but:

- It must follow workspace `CLAUDE.md`, `BOOTSTRAP.md`, and `skills/`.
- It must not change Claude's actual workflow or user-facing answer by itself.
- It must not enter Review before the Verify Gate passes.
- It must keep the journey in `ingest` or `verify` while Verify is unfinished.
- Backend rechecks Review requests with `readReviewGate`.

Developers should treat MCP journey updates as hints that are validated and projected by backend state, not as authoritative workflow completion.

### Workflow Continuation Supervisor

Long-running knowledge workflows are not treated as a single agent call that will always run to completion. The backend runs Claude in rounds:

```text
runAgentPrompt(user or continuation prompt)
  -> read workspace artifacts
  -> decide whether more work is still pending
  -> optionally runAgentPrompt(continuation prompt)
```

The agent is the executor. The backend continuation loop is the supervisor. Workspace files are the source of truth.

This matters because prompts such as "continue until finished" are behavioral instructions, not hard guarantees. Claude may finish a response after completing only part of a long workflow, or it may report progress in chat before the durable workspace state has actually changed. Backend code must therefore verify completion from structured artifacts instead of trusting assistant text.

The current continuation mechanism is intentionally scoped to Ingest. After each chat run, `readWorkflowContinuation()` checks the active `ingest-plans/*.json`:

- If any batch is still non-terminal, backend sends an execute continuation that lists the pending batches and tells Claude to continue from the first pending batch.
- If all batches are terminal but finalization is incomplete, backend sends a finalize continuation so Claude completes the owning ingest skill's Verify Gate and prepares Review artifacts.
- If the plan says `completed`, backend still verifies that the matching draft, `meta.json`, Verify result, and Review gate are actually ready before stopping.
- If the workflow still cannot converge after the bounded continuation loop, backend emits a user-facing support message instead of silently finishing.

Use the same pattern for future long workflows: create a durable plan/checkpoint artifact, make the backend read it after each agent round, generate a narrow continuation prompt for the next unfinished step, and stop only when the artifact-derived completion conditions are true.

### Frontend Display Rules

The build stepper is a projection of `flow` and `phase`:

- `flow=build` shows Bootstrap, Ingest, Verify, Review.
- `phase=ready` exits the build journey and enters the maintenance experience.
- Completed nodes with artifacts are clickable so users can inspect previous outputs.
- A node is viewable only if it is the current node or has artifacts.

The frontend should not invent journey transitions independently. It renders the `JourneyState` and artifact-derived payloads emitted by the backend.

### Development Invariants

When changing the journey, preserve these invariants:

- Keep top-level workflow position in `phase`.
- Keep Bootstrap-only detail in `bootstrap.status`.
- Keep Verify progress in `verify.status`, not `verify.phase`.
- Do not add post-Bootstrap states back into `bootstrap.status`.
- Do not bypass the Verify Gate for `pending_review/drafts`.
- Do not count `.claude/worktrees/...` artifacts as final workspace artifacts.
- Do not let UI-only buttons or frontend routing decide lifecycle state.
- Do not make Review available just because draft files exist.
- Do not create a new draft when editing the active Review draft.
- Prefer backend gates and artifact projection over prompt-only guarantees.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm smoke:ontology
pnpm smoke:ontology:claude # optional, requires proxy credentials such as AZURE_OPENAI_API_KEY
pnpm smoke:ontology:claude-edit # optional, verifies real file edit + same-session resume
```

Useful targeted checks include:

```bash
pnpm test:auth
pnpm test:resource-picker
pnpm test:support-reports
pnpm test:azure-pool
pnpm test:chat-failure
pnpm test:video-sop-model-http
pnpm test:operation-store
pnpm test:operation-history-api
pnpm test:operation-history-ui
pnpm smoke:maintenance-journey
pnpm smoke:external-knowledge-catalog
pnpm smoke:a2a-external-query
pnpm smoke:knowledge-sharing
```

See `docs/ONTOLOGY_STUDIO_STATUS.md` for current implementation status and known gaps.
