# Interface Boundary Audit

Use this reference only from `references/post-repo-ingest-gap-check.md` during a backend-validated `coding-repo-ingest` run.

Scope: the active draft under `pending_review/drafts/<draft-id>/knowledge/`. Do not generate standalone reports, do not ask for user approval, and do not write directly to root `knowledge/`.

## When To Run

Run this pass when any of these are true:

- the repo surface map contains controller, router, API, MCP tool, webhook, or API-client boundaries
- the first draft created or modified pages under `pending_review/drafts/<draft-id>/knowledge/interfaces/`
- the post-repo gap check finds source files that look like interface definitions or live interface consumers

If the source is not a backend-validated code repository under `raw/repos/<id>`, stop and return to the owning workflow.

## 1. Scan Interface Candidates

Search the ingested repository for files that define HTTP endpoints, service boundaries, MCP tools, webhooks, or live API consumers.

Detection patterns by stack:

Java / Spring:
- files matching `*Controller*.java` under `*/interfaces/*` or `*/controller/*`
- files matching `*Api.java` under `*/api/*`, excluding `*AutoConfiguration*`, `*ApiResponse*`, and `*ApiPaths*`
- files matching `*McpTools*.java` under `*/mcp/*`
- files with `@RestController`, `@RequestMapping`, `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, or `@McpTool`

.NET / ASP.NET:
- files matching `*Controller*.cs` under `*/Controllers/*`
- files with `[ApiController]`, `[Route]`, `[HttpGet]`, `[HttpPost]`, `[HttpPut]`, or `[HttpDelete]`

Node / TS backend:
- router files with `router.get`, `router.post`, `router.put`, `router.delete`, `app.get`, `app.post`, `server.route`, or framework route decorators
- files under `routes/`, `controllers/`, `api/`, `server/`, or `mcp/` that register public endpoints or tools

Vue / React / TS frontend:
- files under `*/apis/*`, `*/api/*`, `*/services/*`, or shared request/client modules that define HTTP calls
- frontend API clients are consumers, not interfaces by themselves; use them to find live backend or external service boundaries that may be missing from interface pages

For each candidate, extract:

- file path relative to the repo root
- class, router, module, or tool name
- bounded context or module derived from directory structure
- type: `controller`, `api`, `router`, `mcp-tool`, `webhook`, `frontend-api-client`, or `test-controller`
- route prefix, method-level paths, HTTP methods, tool names, or external base URL where available
- liveness evidence: active route/menu/page caller, registered controller/router, scheduler/listener/webhook registration, or live frontend caller

Filter out:

- auto-configuration classes (`*AutoConfiguration*`)
- DTO/response/path constant classes (`*ApiResponse*`, `*ApiPaths*`)
- test controllers (`*Test*Controller*`, `SchedulerTestController`, `BnpPaymentTestController`)
- files under `test/`, `tests/`, `target/`, `dist/`, `build/`, `.git/`, or generated output
- code marked deprecated, legacy, disabled, or guarded by an always-false feature flag unless the source page needs a caveat

## 2. Compare Against Draft Interface Knowledge

Read the draft `pending_review/drafts/<draft-id>/knowledge/interfaces/` directory if it exists. Also read any draft business pages under `pending_review/drafts/<draft-id>/knowledge/` touched by the ingest that mention endpoints, tools, API boundaries, or external service calls.

For each interface candidate:

1. Direct match: a draft interface page with the same boundary, controller, router, or tool name exists.
2. Aggregate match: a draft interface page documents multiple controllers or tools in the same bounded context and explicitly mentions this candidate.
3. BFF or frontend-client match: a frontend API client maps to an existing backend, BFF, or external-service interface page.
4. Source-only match: the source page records the candidate as legacy, dead, deprecated, or not material enough for a standalone page.

Classify each candidate:

- `COVERED` — documented in a draft interface page or explicitly covered by a relevant aggregate page
- `MISSING` — live, stable, material interface boundary is not documented in the draft
- `UNCERTAIN` — may be live or covered, but ownership, route wiring, implementation status, or page mapping cannot be confirmed from this repo alone
- `SKIPPED` — test, generated, dev-only, deprecated, dead, or non-business utility

## 3. Patch The Draft

For each `MISSING` candidate:

- create or update a page under `pending_review/drafts/<draft-id>/knowledge/interfaces/` only when it represents a meaningful external, controller-level, service, webhook, or MCP boundary
- update an existing draft page instead of creating a new page when the candidate is a detail inside an already documented boundary
- update the draft source page so the repository summary reflects the interface boundary
- update `pending_review/drafts/<draft-id>/knowledge/index.md`, `pending_review/drafts/<draft-id>/knowledge/overview.md`, and `pending_review/drafts/<draft-id>/knowledge/log.md` when the interface changes the knowledge map

For each `UNCERTAIN` candidate:

- do not invent route semantics or business behavior
- record the uncertainty in the most relevant draft source or interface page as a caveat, contradiction, or verification note
- mention the uncertainty in the owning ingest workflow's final response

For each `SKIPPED` candidate:

- do not create an interface page
- if it could confuse future maintenance, record it as legacy/deprecated/non-business in the draft source page's Contradictions section

## 4. Validate Endpoint Paths

For every draft interface page created or modified during the repo ingest or this gap check, re-open the source code and verify:

- class-level, controller-level, router-level, or app-level route prefixes
- method-level route paths and HTTP methods
- full relative endpoint paths after prefix + method path concatenation
- MCP tool names or webhook route names when applicable
- frontend API client paths against the backend or external-service boundary they consume

Then verify the page is internally consistent:

- `###` endpoint headings use the same full relative paths as `Key Endpoints`
- `Authentication` references the same paths and access assumptions as the endpoint sections
- page title and summary describe the logical interface boundary, not just one implementation class
- source references point to the files that prove the route, tool, or client boundary

Fix any mismatch immediately in the draft before returning to the main gap-check workflow.

## Decision Rules

- One knowledge page per logical interface boundary, not per implementation class.
- Multiple controllers in the same bounded context can map to one interface page when they serve one coherent API boundary.
- BFF modules can use one aggregate page unless the endpoint set is large enough to obscure separate business domains.
- MCP tools can be grouped by module or split by agent role when their responsibilities differ.
- Frontend API clients can prove a missing backend or external boundary, but they should not become interface pages unless the knowledge base intentionally documents client-facing contracts.
- Test controllers, dev-only endpoints, generated endpoints, and dead code must not become current knowledge.
- Declared but unimplemented stubs should be `UNCERTAIN` unless the source clearly proves they are live.
- Never promote a code path to current knowledge without liveness evidence.

## Output

Do not produce a standalone user-facing report. Return findings to `post-repo-ingest-gap-check` as working context:

- what interface candidates were checked
- which draft pages were created or updated
- which uncertain or skipped candidates were recorded as caveats
- which endpoint path mismatches were fixed
