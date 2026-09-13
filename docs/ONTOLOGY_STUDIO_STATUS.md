# Ontology Studio Backendization Status

Last updated: 2026-06-26

## Product Target

把 `ontology-studio` 从纯 mock Vite React 原型，推进成真实多租户 Ontology Agent Studio：

- 每个 ontology 有隔离 workspace。
- 初始 `wiki/` 来自 `/root/code/wiki-starter/backend/agent/skills`，也就是现有完整 Claude agent 目录。
- Web 应用要尽量不遗漏地呈现“在该 wiki 目录里执行 Claude Code CLI”的效果：会话、流式文本、tool 使用、文件树、文件内容、Journey 状态。
- Claude 执行路径使用 Claude Agent SDK；模型连接逻辑对齐 `/root/code/agent-factory-runtime/frontend`：支持 `STEWARD_PROXY_MODEL` / `ONTOLOGY_PROXY_MODEL` 通过 Anthropic 协议代理转 Azure/OpenAI。

## Overall Progress

| Area | Status | Notes |
| --- | --- | --- |
| PRD-0 Shared Contract / Scaffold | Done | Contracts、Vite alias、server skeleton、scripts、deps 已建立。 |
| PRD-1 Backend Core | Mostly done | IAM/dev fallback、CRUD、workspace、tree/file、safe path、wiki seeding 已完成；DB migration ledger 已加入，仍需 Postgres runtime smoke。 |
| PRD-2 Claude Runtime | Mostly done | Claude SDK runner、session store、resume、SSE、tool guard、Agent Factory proxy 已接入并通过 Claude smoke；仍需更强 resume/file-edit 验证。 |
| PRD-3 Frontend Foundation | Mostly done | React Query/API client/AuthGuard/ontology list/create/tree/file/session/message 基本接入；mock fallback 默认关闭，需显式配置。 |
| PRD-4 assistant-ui Chat | Mostly done | 已切到 Agent Factory-style assistant-ui Thread/Composer/ActionBar/ToolFallback，后端输出 AI SDK UIMessage stream；本轮修正 Tailwind v4 `@source` 扫描，assistant-ui arbitrary classes 已进入产物。 |
| PRD-5 Journey / Knowledge Ask / Final QA | Partial | Journey API/stream update 有；Knowledge Ask 已接真实后端 wiki-grounded SSE；Graph 已有基于 wiki tree 的只读摘要。 |

## Evidence Checklist

Use this table as the periodic review surface for the full PRD scope. `Evidence` should point to runnable commands, source/doc locations, or observed behavior; `Next proof needed` captures the smallest check that would move the row forward.

| PRD Item | Target Evidence | Current Evidence | Status | Next Proof Needed |
| --- | --- | --- | --- | --- |
| PRD-0 Shared Contract / Scaffold | Shared contracts, aliases, server scaffold, scripts, and dependencies are present and typechecked. | `src/contracts/ontology.ts`, Vite/TS alias, `server/`, package scripts; `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass after proxy changes. | Done | None for current slice. |
| PRD-1 Backend Core | CRUD, IAM/dev fallback, workspace isolation, safe file APIs, wiki seeding, and persistence path are verified. | Ontology/session/file APIs, safe path guards, workspace seed from `/root/code/wiki-starter/backend/agent/skills`, in-memory fallback, migration ledger, and session rename/delete endpoints are implemented. | Mostly done | Add a Postgres-backed runtime smoke path. |
| PRD-2 Claude Runtime | Claude SDK runs inside ontology workspace with tenant/user isolation, streaming, resume/session store, tool guard, and Agent Factory proxy compatibility. | Runner, SSE route, persisted run events, workspace tool guard, isolated `CLAUDE_CONFIG_DIR`, disabled Bash, Anthropic-to-OpenAI proxy route, `pnpm smoke:ontology:claude`, and `pnpm smoke:ontology:claude-edit` pass. | Mostly done | Add Postgres-backed session-store smoke and richer UI stream verification. |
| PRD-3 Frontend Foundation | Frontend uses backend-backed ontology list/create/tree/file/session/message APIs with explicit fixture fallback only. | React Query provider, AuthGuard, API client, ontology hooks, real list/create, tree/file/journey/session/message/chat integration, explicit mock fallback gate, `pnpm lint`, and `pnpm build` pass. | Mostly done | Manual browser chat verification remains. |
| PRD-4 assistant-ui Chat | Chat is implemented with assistant-ui Thread/Composer/Markdown/ToolFallback while preserving live SSE and tool cards. | `OntologyStewardChatPanel` uses AI SDK `useChat` + `DefaultChatTransport`, adapts messages into assistant-ui `useExternalStoreRuntime`, and renders copied Agent Factory-style Thread/Composer/ActionBar/ToolFallback. `pnpm build` verifies Tailwind emits `max-w-(--thread-max-width)`, `rounded-(--composer-radius)`, `p-(--composer-padding)`, and `px-1.75`. | Mostly done | Manual browser verification of exact Agent Factory visual parity remains. |
| PRD-5 Journey / Knowledge Ask / Final QA | Journey state, wiki-grounded Ask, Graph, and final QA evidence are reviewable from the UI and smoke tests. | Journey API and stream updates exist; Explorer reads real wiki files; KnowledgePanel Ask streams real backend Claude answers grounded in `wiki/`; Graph button now opens a read-only wiki-tree graph summary. | Partial | Add automated UI/Ask/Graph smoke coverage. |

## Implemented

### Shared / Project Setup

- `src/contracts/ontology.ts` 定义前后端共享 ontology 类型和 `OntologyStreamEvent`。
- `@/* -> src/*` alias 已配置到 Vite/TS。
- Node/Express backend 已创建在 `server/`。
- package scripts：`dev:frontend`、`dev:server`、`dev`、`typecheck`、`smoke:ontology`、`smoke:ontology:claude`、`smoke:ontology:claude-edit`。
- 依赖已加入：Express、pg、zod、tsx、Claude Agent SDK、assistant-ui、React Query、zustand、axios 等。

### Backend Core

- `GET /healthz`。
- Ontology APIs：list/create/get/patch/delete。
- Session/message APIs：list/create/list messages/chat。
- File APIs：tree/file read/journey。
- IAM behavior：
  - Dev fallback：无 IAM 时使用 `dev-user` / `dev-tenant`。
  - IAM enabled 时要求 `Authorization` + tenant header，并校验 tenant/company context。
- Persistence：
  - 有 Postgres schema bootstrap。
  - 无 `DATABASE_URL` 时使用 in-memory repository，方便原型/本地 smoke。
- Workspace manager：
  - 默认 root：`data/ontology-workspaces`。
  - 安全 path segment / safe file path 校验。
  - 禁止 absolute path、`..` escape。
- New ontology workspace：
  - 创建 tenant/user/ontology 隔离目录。
  - 初始化 `wiki/` from `/root/code/wiki-starter/backend/agent/skills`。
  - 创建 `.runtime/journey-state.json`。
  - 统计 seeded markdown page count。

### Claude Runtime

- `server/chat/claude-runner.ts` 已实现：
  - fallback mode：不启用 Claude 时仍能验证 API/session/workspace/event plumbing。
  - real mode：`ONTOLOGY_ENABLE_CLAUDE=true` 时使用 Claude Agent SDK `query()`。
  - `cwd = ontology workspace`。
  - `resume = ontology_sessions.claude_session_id`。
  - `sessionStore = createPostgresClaudeSessionStore(...)`。
  - `settingSources = ["project"]`。
  - enabled tools：`Read`、`Write`、`Edit`、`MultiEdit`、`Glob`、`Grep`。
  - `Bash` disabled。
  - `CLAUDE_CONFIG_DIR` 按 tenant/user 隔离。
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。
  - `canUseTool` workspace path guard。
- `server/chat/routes.ts`：
  - JSON chat response 保持兼容。
  - `stream=true` 时实时 SSE 输出 `text-delta`、`tool`、`journey-state`、`tree-updated`、`finish`、`message`、`error`。
  - run events 会持久化。
  - assistant final message 会落库。
- Agent Factory proxy logic porting：
  - 新增 Express proxy route `server/proxy/anthropic-openai-proxy.ts`。
  - Mount at `/api/proxy/v1/messages`。
  - 支持 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/api/proxy`。
  - 支持 API key format：`proxy:{provider}:{model}`，如 `proxy:azure:gpt-5.4`。
  - Anthropic `/v1/messages` -> OpenAI Chat Completions request transform。
  - OpenAI/Azure SSE -> Anthropic SSE response transform。
  - 默认 Azure URL 与 Agent Factory 保持一致，可通过 env override。

### Frontend

- `src/main.tsx` 已接 React Query provider 和 AuthGuard。
- API client 自动携带 `Authorization` 与 `TenantID`。
- Ontology service/hooks：list/create/update/delete/tree/file/journey/session/messages/chat。
- `App.tsx` 已从 mock list 切到真实后端 list/create；mock fallback 默认关闭，只能通过 `VITE_ENABLE_MOCK_FALLBACK=true` 显式打开。
- `KnowledgePanel` 对真实 ontology 读 backend tree/file，对 `proj-*` 用 mock fallback。
- `ChatPanel`：
  - 无 backend ontology 时，“Create a new Ontology” 会创建真实后端 ontology，不再启动 mock journey。
  - 对真实 ontology 使用 live SSE。
  - assistant 文本增量显示。
  - tool_use 显示为简易 tool card。
  - journey-state stream event 更新右侧 JourneyPanel。
  - tree-updated 后 invalidates tree/file/journey/messages queries。
  - Stop 按钮 abort 当前 stream。

## Verified

Latest post-proxy verification, all passing:

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm smoke:ontology
pnpm smoke:ontology:claude
pnpm smoke:ontology:claude-edit
```

Evidence from latest run:

- `pnpm smoke:ontology`: created a seeded ontology, verified safe path rejection, fallback chat, SSE events, and journey state.
- `pnpm smoke:ontology:claude`: passed through the Agent Factory-style proxy path and returned latest Claude session `7e20a8b6-ee5d-4466-801f-6a0dc89f0feb`.
- `pnpm smoke:ontology:claude-edit`: passed deeper runtime verification by asking Claude SDK to append a unique marker to `wiki/index.md`, reading the file through the API, then asking a second turn in the same app session to recall the marker; latest Claude session `2f5b801b-438a-46b7-9fa0-c920d3c16759`.
- `pnpm build`: production Vite build succeeded; only warning is chunk size over 500 kB.

## Current Active Thread

The user clarified that Ontology Studio should use the same Claude SDK model/proxy logic as Agent Factory Runtime instead of relying on local Claude Code login.

Current work has completed the first verified proxy slice:

- Copied/adapted Agent Factory Anthropic-to-OpenAI proxy route into Express.
- Added runner env logic to set:
  - `ANTHROPIC_BASE_URL=http://127.0.0.1:${ONTOLOGY_SERVER_PORT}/api/proxy`
  - `ANTHROPIC_API_KEY=proxy:${provider}:${model}`
- Default model/provider behavior:
  - `ONTOLOGY_PROXY_MODEL` if set
  - else `STEWARD_PROXY_MODEL` if set
  - else `gpt-5.4` when `AZURE_OPENAI_API_KEY` exists
  - smoke scripts set `ONTOLOGY_PROXY_MODEL=gpt-5.4` explicitly when Claude mode is enabled, so they do not accidentally fall back to local login in clean environments
  - provider defaults to `azure`

Post-proxy verification now passes. The previous local-login failure (`Not logged in · Please run /login`) is resolved by routing Claude Agent SDK through the Agent Factory-style proxy.

## Assistant UI Docs Check

2026-06-26 review of `https://assistant-ui.com/llms-full.txt`:

- This repo is an existing Vite React app, so `npx assistant-ui init --yes` is not the right path because init targets Next.js App Router scaffolding.
- The relevant supported pattern is manual setup/custom backend: assistant-ui Thread components + an assistant runtime.
- Our backend request/response is compatible with the AI SDK `UIMessage` shape (`messages[].parts[]`) and the response is an AI SDK UIMessage stream.
- Because the project is on Vite and currently owns chat state through `@ai-sdk/react`, `useExternalStoreRuntime` is acceptable; a later cleanup can switch to `@assistant-ui/react-ai-sdk` if we align AI SDK major versions with assistant-ui’s runtime package.
- CSS issue root cause: Tailwind v4 was not reliably scanning the copied Agent Factory assistant-ui classes in dev/build. Added `@source "./**/*.{ts,tsx}"` after all imports so arbitrary utilities like `max-w-(--thread-max-width)` compile.


## Bootstrap Journey Observation Notes

Last updated: 2026-06-29

Source of truth for knowledge-base creation is `/root/code/wiki-starter/backend/agent/skills/CLAUDE.md` plus `/root/code/wiki-starter/backend/agent/skills/BOOTSTRAP.md`, not Agent Factory. Agent Factory remains only a UI/streaming reference.

Key bootstrap rules observed from source files:

- `CLAUDE.md` first-run gate: before any normal intent recognition, if root `BOOTSTRAP.md` exists, the agent must read/follow bootstrap and must not proceed to normal workflows.
- `BOOTSTRAP.md` Step 1: understand the user's purpose and wait until the choice is clear.
- `BOOTSTRAP.md` Step 2: generate a schema proposal from user goal + reference template + stability principles; `raw/` is only supporting signal, not structural ground truth.
- `BOOTSTRAP.md` Step 3: present proposed schema and ask short alignment questions.
- `BOOTSTRAP.md` Step 4: generate page format from the confirmed schema.
- `BOOTSTRAP.md` Step 5: output one raw JSON object with `name`, `description`, `emoji`, `wiki_subdirs`, and `naming_conventions`; no markdown fence or trailing commentary.

Product terminology decision:

- New product/code-facing naming should prefer `knowledge` / `knowledgeBase`.
- Existing agent-facing files and legacy workspace/API details may still contain `wiki` / `ontology`; avoid a risky large rename now.
- Do not rewrite the skills prompt just to satisfy UI terminology; project its behavior into UI state passively.

Current plugin observation:

- Claude plugin companion setup is ready in this project.
- Observation job `do-mqym8830-n7k178` was started through `claude-companion.mjs do --background`; plugin-managed Claude session id is `92ab2268`.
- Direct `claude -p --session-id ...` should not be used for this work; it creates misleading manually-managed sessions and may hit sandbox socket failures.

Recommended passive projection into the existing right panel:

- `BOOTSTRAP.md` exists in workspace -> creation/bootstrap mode is active; show `JourneyPanel` bootstrap view instead of normal KnowledgePanel.
- Assistant asks goal/type question -> `bootstrap.step = 1`, no final name/schema yet.
- Assistant emits a `wiki/` directory tree or list of directories -> parse candidate directories into `BootstrapState.pageTypes`, set `step = 2`.
- Assistant asks alignment questions -> keep `phase = bootstrap`, mark schema as proposed but not confirmed.
- Assistant emits final JSON matching the Step 5 schema -> parse into project metadata and `BootstrapState`, mark creation ready/complete.
- Backend hydration or removal of `BOOTSTRAP.md` -> bootstrap inactive; switch the right side back to normal knowledge explorer/ask view.

Projected UI state shape to bridge legacy contracts:

```ts
type KnowledgeCreationState = {
  phase: "bootstrap";
  status: "goal_selection" | "schema_proposed" | "alignment" | "schema_confirmed" | "complete" | "hydrated";
  turnIndex: number;
  name: string | null;
  description: string | null;
  emoji?: string;
  pageTypes: Array<{ name: string; description: string; confirmed: boolean }>;
  sources: string[];
  step: number;
  totalSteps: number;
  rawBootstrapResult?: {
    name: string;
    description: string;
    emoji: string;
    wiki_subdirs: string[];
    naming_conventions: string[];
  };
};
```

Implementation constraint for next slice:

- Add a passive observer/projection layer around chat stream/final assistant messages and workspace file state.
- Do not make `CLAUDE.md` output UI state directly.
- Do not rename all existing `ontology` DB/API/routes in this slice.
- Preserve one knowledge base directory with N sessions; sessions bind to one knowledge base and share the same workspace memory.

## Running Issue Log

Keep this section as a living log for periodic reviews. Add new rows instead of rewriting history; close rows by moving status to `Closed` and linking the evidence that closed them.

| ID | Date Opened | Area | Issue / Risk | Status | Owner / Next Action |
| --- | --- | --- | --- | --- | --- |
| OS-001 | 2026-06-26 | Claude Runtime | Proxy-enabled Claude SDK smoke had not been rerun after porting Agent Factory proxy behavior. | Closed | `pnpm smoke:ontology:claude` passed on 2026-06-26 with Claude session `6c39bf06-e240-48d3-8913-86c55dade37c`. |
| OS-002 | 2026-06-26 | Verification | `pnpm lint`, `pnpm build`, and `pnpm smoke:ontology` passed before the proxy port but needed post-port reruns. | Closed | Post-proxy `pnpm lint`, `pnpm build`, and `pnpm smoke:ontology` passed on 2026-06-26. |
| OS-003 | 2026-06-26 | Persistence | Postgres migration ledger exists but has not been exercised against a real Postgres service in this repo. | Open | Add Postgres-backed smoke verifying migrations plus session store rows. |
| OS-004 | 2026-06-26 | Frontend Chat | ChatPanel needed full Agent Factory-style assistant-ui Thread/Composer instead of custom bubble patches. | Partially closed | Thread/Composer/ActionBar/ToolFallback are now assistant-ui based; remaining work is browser visual parity and optional migration to `@assistant-ui/react-ai-sdk` when AI SDK version is aligned. |
| OS-005 | 2026-06-26 | Product Surface | Knowledge Ask and Graph were not complete; Explorer read real wiki files, but Ask/Graph remained gaps. | Closed | Knowledge Ask now streams backend wiki-grounded answers and was manually verified in browser; Graph button now opens a read-only wiki-tree summary. |
| OS-006 | 2026-06-26 | Auth / Security | `/api/auth/exchange-token` is referenced by frontend patterns but not implemented, and proxy route needs production auth restrictions. | Partially closed | Added `/api/auth/exchange-token` with dev fallback and IAM SSO token exchange; production proxy access restriction remains open. |
| OS-007 | 2026-06-26 | Claude Proxy | Proxy initially did not flush a trailing partial upstream SSE buffer, which could drop the last token/tool delta if upstream ended without a newline. | Closed | Added trailing buffer flush in `server/proxy/anthropic-openai-proxy.ts`; all smoke checks pass afterward. |
| OS-008 | 2026-06-26 | Claude Proxy | Claude smoke only forced proxy when proxy env/Azure key existed, risking fallback to local login in clean envs. | Closed | `scripts/smoke-ontology.mjs` sets `ONTOLOGY_PROXY_MODEL` explicitly for Claude smoke modes. |
| OS-009 | 2026-06-26 | Frontend Config | UI could silently fall back to fixture projects when backend was unavailable, making local chat trials look mock-only. | Closed | Added `VITE_ENABLE_MOCK_FALLBACK=false` local config and gated fallback behind `VITE_ENABLE_MOCK_FALLBACK=true`; Chat welcome create now calls real ontology creation. |
| OS-010 | 2026-06-26 | Sessions | Sidebar session rename/delete needed backend/client wiring. | Closed | Added PATCH/DELETE session API and verified with a session rename/delete smoke against an isolated local server. |

## Remaining Gaps

1. **assistant-ui visual parity**
   - Current chat surface uses assistant-ui Thread/Markdown/ToolFallback/Composer and AI SDK UIMessage streaming.
   - Need final browser pass against Agent Factory for exact spacing/theme behavior.

2. **Deeper Claude runtime verification**
   - Basic proxy-enabled Claude smoke passes.
   - Real file edit plus second-turn resume smoke passes in in-memory mode.
   - Need verify transcript mirror/sessionStore contents under Postgres and tool-card behavior in browser UI.

3. **Knowledge Ask**
   - Explorer reads real wiki files.
   - Ask tab now uses a wiki-grounded backend chat prompt/session for real ontology IDs.
   - Manual browser verification passed by asking `CLAUDE.md 是做什么的？` and receiving cited answers from the generated wiki files.
   - Need automated browser/smoke coverage.

4. **Graph tab**
   - No longer a blank placeholder: it now shows a read-only graph summary derived from the current wiki tree.
   - Still needs real graph extraction/visualization if product requires semantic edges.

5. **IAM exchange endpoint**
   - Express backend now implements `/api/auth/exchange-token`.
   - Dev mode returns a deterministic local token; IAM mode exchanges code through SSO token endpoint.
   - Real SSO has not been verified against a live IAM service.

6. **DB migrations / Postgres runtime smoke**
   - Migration ledger exists.
   - Need Postgres-backed smoke for migrations, `claude_session_store_entries`, and resume after restart.

7. **Security hardening**
   - Proxy route is mounted for local backend use; before production, restrict access/auth and avoid exposing raw model proxy beyond trusted server-side SDK calls.
   - SDK env still inherits much of `process.env`; can be narrowed later.

## Recommended Next Slice

1. Try chat locally in real-backend mode:
   - open `http://127.0.0.1:5174`, hard refresh, click `Create a new Ontology`, and send a chat prompt;
   - if fixture projects appear, verify `VITE_ENABLE_MOCK_FALLBACK=false` and restart Vite.
2. Add Postgres-backed Claude runtime smoke:
   - verify `claude_session_store_entries` transcript mirror,
   - verify resume survives server restart,
   - keep current no-Bash tool policy.
3. Complete assistant-ui chat replacement:
   - Copy minimal Agent Factory assistant-ui components.
   - Keep current three-column shell.
4. Add automated browser smoke for ChatPanel + Knowledge Ask + Graph.
5. Add production hardening:
   - Auth protect proxy.
   - Restrict/narrow SDK env inheritance.
   - Add Postgres smoke.


## Verification Log

| Date | Command | Result | Notes |
| --- | --- | --- | --- |
| 2026-06-26 | `pnpm typecheck` | Pass | Post proxy buffer/model fixes. |
| 2026-06-26 | `pnpm lint` | Pass | Post proxy buffer/model fixes. |
| 2026-06-26 | `pnpm smoke:ontology:claude-edit` | Pass | Re-run after proxy buffer/model fixes; real Claude SDK via proxy appended marker to `wiki/index.md` and recalled it on second turn. |
| 2026-06-26 | `pnpm smoke:ontology:claude` | Pass | Re-run after proxy buffer/model fixes; real Claude SDK via Agent Factory-style proxy. |
| 2026-06-26 | `pnpm smoke:ontology` | Pass | Deterministic fallback plus SSE event coverage. |
| 2026-06-26 | `pnpm build` | Pass | Vite build passes with chunk-size warning only. |
| 2026-06-26 | `pnpm typecheck` | Pass | After gating mock fallback behind `VITE_ENABLE_MOCK_FALLBACK=true`. |
| 2026-06-26 | `pnpm lint && pnpm build && pnpm smoke:ontology` | Pass | Build still has chunk-size warning only; smoke verified seeded wiki and backend plumbing. |
| 2026-06-26 | Session rename/delete smoke | Pass | Isolated server: create ontology, PATCH session preview, list verifies rename, DELETE session, list verifies deletion. |
| 2026-06-26 | `pnpm build` | Pass | After assistant-ui Tailwind `@source` fix; no PostCSS import-order warning, chunk-size warning only. |

## Local Trial Notes

2026-06-26 chat trial config update:

- `.env.local` now enables real Claude SDK mode through the Agent Factory-style proxy: `ONTOLOGY_ENABLE_CLAUDE=true`, `ONTOLOGY_PROXY_PROVIDER=azure`, `ONTOLOGY_PROXY_MODEL=gpt-5.4`.
- `server/env.ts` now loads `.env` / `.env.local` for the Express server, so `pnpm dev:server` picks up local config without extra shell exports.
- `src/App.tsx` no longer keeps mock ontology projects by default. Mock projects appear only when `VITE_ENABLE_MOCK_FALLBACK=true` or when an explicit `proj-*` fixture is selected.
- Current running backend health: `GET /healthz` returns OK and `GET /api/v1/ontologies` returns real dev ontology rows for `TenantID: dev-tenant`, so the UI should show backend-backed data.
- If the browser still shows mock rows, hard refresh the Vite page and ensure Vite was restarted after `.env.local` changed.

Prior manual/browser checks:

- KnowledgePanel Ask tab used real backend stream for `CLAUDE.md 是做什么的？` and returned wiki-cited answer.
- Graph button opens read-only wiki-tree graph summary with page/folder/link counts.
- `curl POST /api/auth/exchange-token` returns dev access/refresh token with local IAM disabled.
- `pnpm build` passed after Knowledge Ask integration; Vite build reports chunk-size warning only.

## Current Local Config Note

- `.env.local` now contains `VITE_ENABLE_MOCK_FALLBACK=false`, so the UI should not silently show `proj-*` fixtures when the backend is down.
- To deliberately demo fixtures, set `VITE_ENABLE_MOCK_FALLBACK=true` and restart Vite.
- Current live backend at `http://127.0.0.1:8787` reports healthy and returns at least one real dev ontology for `TenantID: dev-tenant`.

## Concept Clarification: Wiki / Sessions / Memory

2026-06-26 clarification from product review:

- One wiki ontology maps to exactly one controlled workspace directory: `tenants/{tenantId}/users/{userId}/ontologies/{ontologyId}`.
- The workspace contains the shared ontology memory surface: `CLAUDE.md`, `wiki/`, `.runtime/journey-state.json`, `raw/`, and `sources/`.
- One ontology can have N app sessions in `ontology_sessions`; sessions are different chat threads over the same ontology workspace.
- Sessions share workspace memory by design because Claude SDK runs with `cwd` set to the ontology workspace. Any wiki/runtime file updates from one session are visible to other sessions through tree/file APIs and subsequent Claude runs.
- Conversation transcript/resume is still session-specific through `ontology_sessions.claude_session_id`; this keeps chat threads separate while allowing them to share the wiki/runtime memory in the directory.
- If product later wants all chat transcripts to be merged into a single Claude resume chain, change the session-store/resume keying intentionally; do not accidentally collapse sessions while implementing shared workspace memory.

## IAM Visibility Update

- The sidebar user footer now reflects actual auth mode instead of hardcoded `Keyue`/tenant options.
- With `VITE_IAM_ENABLED=false`, the UI shows `DEV` / `Dev fallback`, matching backend dev tenant behavior.
- With `VITE_IAM_ENABLED=true`, AuthGuard redirects to SSO, and the sidebar shows IAM status/tenant after token hydration.
- `server/auth/routes.ts` accepts `IAM_CLIENT_ID` / `IAM_CLIENT_SECRET` as the token-exchange credentials.
- `.env.private` is used for local secrets and is git-ignored; `.env.local` keeps only public/dev-safe IAM config.

## IAM Hydration Update

2026-06-26 follow-up:

- Added `GET /api/auth/me` so the frontend can hydrate current user and tenant from the backend instead of keeping the default `dev-tenant` after login.
- `AuthGuard` now applies user/tenant data returned by `/api/auth/exchange-token`; if the token exchange response does not include profile fields, it calls `/api/auth/me` with the access token before marking auth checked.
- Backend IAM mode now uses `IAM_CLIENT_ID` / `IAM_CLIENT_SECRET` for token exchange and accepts tenant claims from `companyCode`, `tenantId`, `tenant_id`, `tenants`, or `companyCodes`.
- Backend env precedence changed so explicit `ONTOLOGY_IAM_ENABLED=false` overrides any inherited `VITE_IAM_ENABLED=true`; this prevents local smoke/dev servers from accidentally requiring IAM because of shell-level frontend env.
- Smoke scripts now force `ONTOLOGY_IAM_ENABLED=false` / `VITE_IAM_ENABLED=false` unless they are specifically testing IAM.

Verification added:

- `GET /api/auth/me` dev fallback smoke passed with custom `TenantID` and `x-user-id` headers.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm smoke:ontology`, and `pnpm smoke:ontology:postgres` pass after IAM hydration changes.

## New Chat / Session Model Update

2026-06-26 follow-up:

- Sidebar `New Chat` now creates a new `ontology_sessions` row under the currently selected backend ontology instead of creating a new ontology directory every time.
- If no backend ontology is selected, `New Chat` falls back to creating the first ontology, so the empty-state path still works.
- `My Ontologies` card creation and Chat welcome `Create a new Ontology` still create a new ontology/workspace directory.
- Smoke coverage now verifies the intended model:
  - one ontology creates one workspace directory;
  - two app sessions can write notes into the same `wiki/index.md` shared workspace memory;
  - each session transcript remains separate and does not contain the other session's user prompt.

Verification added:

- `pnpm typecheck` passed after routing New Chat to session creation.
- `pnpm smoke:ontology` passed with multi-session shared workspace memory assertions.
- `pnpm lint`, `pnpm build`, and `pnpm smoke:ontology:postgres` passed after the session-model change.

## Assistant UI / Typewriter Update

2026-06-26 follow-up:

- Added local assistant-ui component surface under `src/components/assistant-ui/`, following the Agent Factory component split:
  - `thread.tsx`
  - `markdown-text.tsx`
  - `tool-fallback.tsx`
  - `user-plain-text.tsx`
  - `attachment.tsx`
  - `tooltip-icon-button.tsx`
- `ChatPanel` now renders messages through `OntologyThread` instead of inline ad-hoc message JSX.
- Tool calls render through a dedicated `ToolFallback` card, keeping current Claude SDK tool stream visibility.
- Live assistant text now uses a local typewriter buffer: SSE `text-delta` events enqueue into a buffer and render out at a fixed cadence before the run is considered visually complete.
- This is still a scoped/cut-down port, not the full Agent Factory assistant-ui runtime projection. The next deeper step is replacing the custom composer/runtime adapter with real `@assistant-ui/react` primitives if product requires exact Agent Factory behavior.

Verification added:

- `pnpm typecheck` passed after assistant-ui component extraction and typewriter buffering.
- `pnpm lint`, `pnpm build`, and `pnpm smoke:ontology` passed after the assistant-ui/typewriter change.
- Browser reload redirected to the staging IAM login page in the currently running frontend, confirming IAM guard is active in that runtime environment.

## IAM Product Login Flow Update

2026-06-26 follow-up:

- Added a real `/login` route and moved IAM callback handling there.
- Protected app routes now use `AuthGuard`; when IAM is enabled and no valid token/profile exists, users are sent to `/login?next=<original-url>` instead of seeing the studio with a fallback `Development User`.
- `/login` exchanges IAM `code` through `/api/auth/exchange-token`, hydrates the Zustand user/tenant store from token response or `/api/auth/me`, then returns to the requested app route.
- Zustand user store now starts with `userInfo=null` when `VITE_IAM_ENABLED=true`; `Development User` is only used in explicit dev fallback mode.
- Sidebar now shows `IAM user`/empty tenant only while unauthenticated; in normal product flow the sidebar is behind `AuthGuard`, so it should show the real IAM user and tenant after login.
- `.env.local` is set to product-mode IAM flags: `VITE_IAM_ENABLED=true` and `ONTOLOGY_IAM_ENABLED=true`. Smoke scripts still override IAM off for deterministic local API tests.

Verification added:

- Browser: navigating to `http://127.0.0.1:5174/` redirects to `http://127.0.0.1:5174/login?next=...` and does not render the studio with `Development User`.
- Browser: clicking `Continue to IAM` navigates to staging IAM with `redirect_uri=http://127.0.0.1:5174/login` and state `/`.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm smoke:ontology` pass after the login-flow change.

## 2026-06-26 IAM login correction

- Replaced the interim custom `Sign in with IAM` card with the real ITEM IAM web component on `/login`.
- Unauthenticated app routes now redirect to `/login`, which renders the IAM username/password form directly.
- `/login` still handles OAuth `code` callbacks for compatibility, but the primary product path is now the IAM component `login-success` event.
- Frontend exposes `getOAuthToken` to the IAM component, normalizing Agent Factory-style `{ grantType, username, password, userId }` requests into `/api/auth/exchange-token` calls.
- Backend `/api/auth/exchange-token` now supports both redirect-code exchange and IAM component password/userId grants, matching Agent Factory's token proxy shape.
- Backend token exchange now sends client credentials via HTTP Basic when `IAM_CLIENT_SECRET` exists; `.env.private` holds the real secret.
- Verified current local backend no longer returns `code and redirect_uri are required` for `grantType=password`; fake credentials now reach IAM and return upstream `SSO status 400`, which is expected.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology:iam` passed.
- Browser snapshot at `http://127.0.0.1:5174/login` shows the IAM username/password page (`Sign in to Marketplace`), not the custom card.

## 2026-06-26 IAM token proxy alignment note

- User clarified that login issues must be checked against Agent Factory first, not by guessing alternate IAM request shapes.
- Re-checked Agent Factory references:
  - `/root/code/agent-factory-runtime/frontend/src/app/login/page.tsx`
  - `/root/code/agent-factory-runtime/frontend/src/app/api/auth/exchange-token/route.ts`
  - `/root/code/agent-factory-runtime/frontend/src/lib/server/auth.ts`
- Aligned Ontology Studio token proxy to the same contract:
  - IAM web component calls `getOAuthToken({ grantType, username, password, userId })`.
  - Frontend converts `grantType` to `grant_type` before posting to `/api/auth/exchange-token`.
  - Backend sends `Authorization: Basic base64(IAM_CLIENT_ID:IAM_CLIENT_SECRET)` to `${SSO_URL}oauth2/token`.
  - Backend forwards token body as `application/x-www-form-urlencoded` and no longer tries extra client-secret-in-body variants.
  - Backend now surfaces upstream `error_description`/`message` and upstream HTTP status instead of rewriting all IAM 4xx responses to 401.
- Important: do not brute-force or repeatedly test real IAM usernames/passwords from the agent. Use Agent Factory code comparison and fake-Sso smoke tests unless the user is driving the browser login manually.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology:iam` passed.

## 2026-06-26 Agent Factory backend auth re-check

- User pointed out that Agent Factory has a backend sibling and IAM behavior must be confirmed there, not inferred.
- Checked backend files:
  - `/root/code/agent-factory-runtime/backend/agent_runtime/api/routes/auth.py`
  - `/root/code/agent-factory-runtime/backend/agent_runtime/api/auth_middleware.py`
  - `/root/code/agent-factory-runtime/backend/agent_runtime/runtime/oauth.py`
- Confirmed split of responsibility:
  - Agent Factory backend `/v1/auth/callback` handles OAuth authorization-code callback and token validation for runtime APIs.
  - Username/password login is handled by frontend `/api/auth/exchange-token`, which proxies `grant_type=password` to IAM using Basic client credentials.
  - Agent Factory login page ignores upstream token error details and throws generic `Token exchange failed` to the IAM web component on failed password/userId grants.
- Ontology Studio follow-up:
  - `exchangeIamGrant` now matches Agent Factory login behavior and throws generic `Token exchange failed` for the IAM web component instead of showing upstream captcha/lockout text in the app shell.
  - Backend still preserves Agent Factory-style upstream status/message on the raw API response for diagnostics; it no longer rewrites all IAM 4xx to 401.
- Operational note: if IAM says `Too many failed login attempts`, that is an upstream account/login-state response, likely caused by repeated failed attempts. Do not probe real credentials from the agent; let the user drive the IAM page.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology:iam` passed.
- Local dev server restarted after the change.

## 2026-06-26 Sidebar and port cleanup

- Removed the left-bottom user IAM badge/tag from `Sidebar`.
- Removed `IAM signed in` / auth-mode display from the user menu.
- Removed the `Wiki memory model` explanatory block from the user menu.
- Removed the related dead CSS selectors so those elements cannot reappear accidentally.
- Changed login failure UI from a centered red blocking overlay to a top-right dismissible notice.
- Forced Vite to `server.port = 5174` with `strictPort: true`; it will fail instead of drifting to 5175 when the port is occupied.
- Restarted local frontend; `5174` is listening and `5175` is not.

Verification:
- `rg` found no remaining `Wiki memory model`, `IAM signed in`, or sidebar IAM badge selectors in `src`.
- `pnpm typecheck` passed.
- `pnpm lint` passed.

## 2026-06-26 Workspace upload / ingest slice

- Added backend upload API: `POST /api/v1/ontologies/:ontologyId/files`.
- Uploads are scoped to the current ontology workspace and write into `raw/` by default, with optional `sources/` target.
- Upload file names are sanitized with `path.basename` and safe characters only; path traversal still goes through the workspace safe-path guard.
- Added workspace `writeFile(...)` helper so future raw/source/wiki writes share the same path boundary behavior.
- Chat composer upload now writes selected files into the current backend ontology workspace instead of only attaching local file names.
- Sending a message with uploaded files now includes their workspace paths, e.g. `raw/foo.md`, and instructs Claude to read/ingest those files into `wiki/`.
- Mock/fixture projects still keep local filename-only attachment behavior.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed with upload coverage: unsafe file name `../unsafe smoke.txt` was sanitized to `raw/unsafe smoke.txt` and read back through the file API.
- `pnpm build` passed; Vite chunk-size warning remains informational only.

## 2026-06-26 Workspace tree visibility slice

- Added workspace-scope tree API: `GET /api/v1/ontologies/:ontologyId/tree?scope=workspace`.
- Workspace tree returns `wiki/`, `raw/`, and `sources/` roots so uploaded/raw source files are visible next to generated wiki pages.
- KnowledgePanel now uses workspace tree for backend ontologies, so uploads appear in Explore without waiting for Claude to ingest them.
- Chat file upload invalidates ontology tree queries after each successful upload, refreshing KnowledgePanel automatically.
- Existing default `GET /tree` behavior still returns wiki-only content for compatibility.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed with workspace tree coverage: uploaded raw file appears under `raw/` in `scope=workspace` tree.
- `pnpm build` passed; Vite chunk-size warning remains informational only.

## 2026-06-26 Claude raw-to-wiki ingest smoke

- Added `pnpm smoke:ontology:claude-ingest`.
- The new smoke creates a backend ontology, uploads a raw file into `raw/`, asks Claude Agent SDK to read that raw file, and requires Claude to write `wiki/smoke-ingest.md` with a unique marker.
- The smoke then verifies the generated wiki page through `GET /files?path=wiki/smoke-ingest.md` and verifies it appears in the wiki tree.
- This closes the most important end-to-end wiki loop: upload source -> execute Claude inside ontology workspace -> generate wiki page -> read generated wiki from API/UI data path.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed.
- `pnpm smoke:ontology:claude-ingest` passed with Claude session `3f4f2e88-2464-486c-8dcf-331d8958c064`.
- `pnpm build` passed; Vite chunk-size warning remains informational only.

## 2026-06-26 Agent Factory assistant-ui foundation pass

- Added a shadcn/Tailwind-compatible foundation instead of continuing to hand-roll all assistant UI behavior:
  - `tailwindcss` v4 + `@tailwindcss/postcss` + `tw-animate-css`.
  - `components.json`, `tailwind.config.js`, `postcss.config.js`.
  - `src/lib/utils.ts` with Agent Factory-style `cn(...)`.
  - `src/components/ui/button.tsx` as the first shadcn-compatible primitive copied/adapted from Agent Factory.
- Kept the current Vite app and existing CSS layout intact; Tailwind is now available for incremental Agent Factory component ports rather than requiring a full UI rewrite in one step.
- Improved the current assistant thread to match Agent Factory behavior more closely:
  - streaming assistant messages now show a blinking typing cursor;
  - loading dots only show before the first streamed text/tool content appears;
  - tool calls render as compact Agent Factory-style activity rows with icon, tool name, summary path/pattern, and expandable JSON details;
  - text streamed after a tool card now starts a new assistant message after the tool instead of appending above it;
  - final persisted `message` SSE events no longer duplicate already-streamed text.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed.
- `pnpm smoke:ontology:claude` passed with Claude session `ebbc29cb-5829-4689-af5d-2fa305eac2a6`.
- `pnpm build` passed; Vite chunk-size warning remains informational only.

## 2026-06-26 Chat auto-start loop fix

- Fixed the `Maximum update depth exceeded` loop reported from `App.tsx:133` / `ChatPanel.tsx`.
- Root cause: `autoStartJourney` mounted `ChatPanel` before a backend ontology project was selected, and the ChatPanel effect called `onNewOntology()` again. `handleNewOntology()` then bumped `chatKey`, remounted ChatPanel, and repeated the create/list loop against `/api/v1/ontologies`.
- Changes:
  - `ChatPanel` auto-start now waits until a real `project` exists instead of creating another ontology from inside the effect.
  - Manual welcome-button create still calls `onNewOntology()` when no project exists.
  - Added an `autoStartedRef` guard so the auto-start effect runs only once per active auto-start cycle.
  - Added an `App`-level `creatingOntologyRef` guard so duplicate clicks/effects cannot start overlapping ontology creates.
  - Memoized `onPhaseUpdate` passed to ChatPanel to avoid unnecessary child churn.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed.
- `pnpm build` passed; Vite chunk-size warning remains informational only.

## 2026-06-26 Session switch and root wiki workspace fix

- Fixed new chat/session switching:
  - `ChatPanel` now clears local messages when `currentSessionId` changes to a new empty session instead of keeping the old transcript visible.
  - Session creation writes the new session into React Query cache immediately, so the auto-select effect no longer falls back to the old first session while the sessions list is refetching.
  - Selecting a session or ontology bumps the ChatPanel key to force a clean chat panel boundary.
- Corrected the ontology directory model:
  - A new ontology workspace root is now a direct fork of `/root/code/wiki-starter/backend/agent/skills`.
  - `CLAUDE.md` is now at the workspace root, which is also Claude Agent SDK `cwd`.
  - `raw/`, `sources/`, and `.runtime/` live alongside the forked skills files.
  - Default tree/file APIs now expose the workspace root (`CLAUDE.md`, `AGENTS.md`, skill dirs, etc.) instead of assuming a nested `wiki/` directory.
  - Smoke tests were updated to assert root `CLAUDE.md`, root `index.md`, and root `smoke-ingest.md` paths.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed.
- `pnpm build` passed; Vite chunk-size warning remains informational only.

## 2026-06-26 AI SDK chat payload fix

- Fixed the AI SDK chat request body losing the prompt and sending whitespace-only `message` values.
- The new chat panel now stores the pending prompt in a ref before calling `useChat().sendMessage(...)`, and `DefaultChatTransport.prepareSendMessagesRequest` reads that ref first when constructing the backend payload.
- Backend chat validation now trims `message` and reports `message must contain non-whitespace text` for truly empty payloads, while still falling back to AI SDK `messages` when present.
- This preserves the intended stream chain: Claude Agent SDK events -> backend AI SDK UIMessage SSE -> frontend AI SDK/assistant-style chat surface.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed with AI SDK stream coverage.

## 2026-06-26 Agent Factory-shaped chat request fix

- Replaced the custom `message` chat payload with the Agent Factory / AI SDK request shape:
  - `sessionId`
  - `clientMessageId`
  - `panelState`
  - `disabledConnectors`
  - `messages: [{ role: "user", parts: [{ type: "text", text }] }]`
- `OntologyStewardChatPanel` now lets `DefaultChatTransport` include the AI SDK `messages` array instead of overriding the request body with a custom `message` field.
- Chat transport headers now omit manual `Content-Type`, avoiding the browser request header `application/json, application/json` duplication.
- Smoke coverage now posts an Agent Factory-shaped AI SDK stream payload with no top-level `message`, proving the backend parses the last user text from `messages`.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed with Agent Factory-shaped AI SDK stream coverage.

## 2026-06-26 Agent Factory chat panel migration

- Replaced the hand-rolled ontology message list with an Agent Factory-style assistant-ui runtime boundary.
- `OntologyStewardChatPanel` now only owns the ontology shell/header and adapts ontology IDs/auth/API paths into AI SDK `DefaultChatTransport`.
- Message rendering, assistant/user bubbles, tool cards, composer, copy, export markdown, edit composer, reload, cancel, branch picker, and scroll-to-bottom now live in `src/components/assistant-ui/thread.tsx`, copied/adapted from Agent Factory's `components/assistant-ui/thread.tsx` rather than rebuilt piecemeal.
- `src/components/assistant-ui/tool-fallback.tsx` now accepts assistant-ui tool-call parts (`toolName`, `argsText`, `args`, `result`, `isError`) so Claude Code tool calls render through the same card path.
- Chat requests now use the Agent Factory / AI SDK shape with `messages`, plus ontology-specific metadata (`sessionId`, `clientMessageId`, `panelState`, `disabledConnectors`, `streamFormat`).
- IAM user-info lookup now has a short timeout, in-memory cache, and JWT-claims fallback so tree/file refreshes after chat do not fail just because the IAM user-info endpoint times out.

Verification:
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm smoke:ontology` passed.
- `pnpm build` passed; Vite chunk-size warning remains informational.

## 2026-06-26 Wiki-bound session creation flow

- Clarified the runtime domain model in the UI flow: one wiki ontology owns one forked workspace directory, and every chat session is created under/bound to exactly one ontology id.
- Added deferred creation from the assistant welcome/composer:
  - Clicking `Create a new Ontology` now arms a create-on-send mode instead of immediately creating records.
  - The first submitted message creates an `Untitled Ontology`, initializes the forked skills workspace, uses the default session returned by the create API, then auto-sends that first prompt into the bound session.
  - If the user chooses an existing wiki ontology from the composer knowledge icon, sending creates a new session under that ontology and auto-sends the prompt there.
- Added a wiki ontology picker to the assistant-ui Thread composer and welcome actions so `Chat with Wiki` / `Edit Wiki` can select from the user's existing ontologies before starting a session.
- Kept the regular active-session path unchanged: messages continue through the existing AI SDK stream into `/api/v1/ontologies/:ontologyId/sessions/:sessionId/chat`.

Verification:
- `pnpm typecheck` passed.
- `pnpm build` passed; Vite still reports the existing large-chunk warning only.
