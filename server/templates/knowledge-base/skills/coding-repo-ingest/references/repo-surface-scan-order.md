# Codebase Scan Order

Use this only before ingesting a backend-validated code repository under `raw/repos/<id>`.

The output is not a knowledge page. It is a **scratch repo map** that tells you what must be represented in the knowledge and what still needs verification.

## 1. Establish the repo frame

Read the files that tell you what the repo claims to be:

- `README*`
- repo-local `AGENTS.md` / `CLAUDE.md`
- `docs/`
- build/manifests such as `package.json`, `pnpm-lock.yaml`, `*.sln`, `*.csproj`, `pom.xml`, `build.gradle`, `docker-compose*`
- `.env*`, `appsettings*.json`, `application*.yml`, feature/config option files

Record:

- primary stack and framework
- deployable units or bounded contexts
- declared modules/features
- obvious external systems

## 2. Find runtime entrypoints and wiring

Do not start from `services/`.

Start from the runtime edges that wire the system together.

### .NET / ASP.NET targets

Search for:

- `Program.cs`
- `Startup.cs`
- `AddControllers`
- `MapControllers`
- `MapGroup`
- `Route(`
- `ApiVersion`
- `Authorize`
- `AllowAnonymous`
- `AddHttpClient`
- `HostedService`
- `BackgroundService`
- `IOptions`
- service-registration extension methods

### Vue / TS frontend targets

Search for:

- `main.ts`, `main.js`
- router modules
- `src/app/views`, `src/views`
- `apis/`, `services/`, `composables/`, `stores/`
- locale files
- `axios.create`
- `buildApiUrl`
- `VITE_`
- `import.meta.env`

### Java / Spring targets

Search for:

- `@SpringBootApplication`
- `@RestController`
- `@RequestMapping`
- `@FeignClient`
- `@Configuration`
- `@Bean`
- `@Scheduled`
- `@KafkaListener`
- `@RabbitListener`
- OpenAPI / Swagger config
- Liquibase / Flyway

## 3. Enumerate stable interface boundaries

Look for more than controllers:

- controllers / routers / BFF modules
- webhook handlers
- scheduled jobs
- queue consumers / listeners
- CLI commands / scripts
- upload/download endpoints
- auth/token/callback endpoints
- metrics, audit, notification, reporting, analytics endpoints

Ask:

- Which of these are real stable interface boundaries?
- Which ones are public, anonymous, tenant-facing, or internal-only?

## 4. Enumerate stable module roots

Search feature roots instead of individual classes:

- bounded contexts
- `modules/`, `features/`, `contexts/`, `views/`, `areas/`
- `Application`, `Domain`, `Infrastructure`, `WebApi`
- shared libraries that own business behavior, not just helpers

Ask:

- What are the durable operational slices?
- Which modules are just implementation detail, and which are capability boundaries?

## 5. Search for hidden business logic outside the obvious folders

High-risk locations:

- `docs/`
- `scripts/`
- `tools/`
- migrations / SQL / changelogs
- notification / analytics / metrics / reporting folders
- workflow / approval / audit folders
- feature flags and config switches
- vendor/client wrappers
- upload/storage helpers with domain-specific branching

Recent misses in this repo family came from exactly these places:

- controller continuity drift between old and new repos
- modules hidden under generic names such as `dashboard`, `discover`, `analytics`, `management`
- prototype route groups that looked too small to matter
- local metrics / PostHog logic living outside the initially scanned business module

## 6. Search for external dependencies and cross-system boundaries

Search for:

- hostnames and `http://` / `https://`
- `AddHttpClient`
- `FeignClient`
- SDK/client wrappers
- `baseURL`
- `VITE_` / env-configured origins
- vendor names such as `IAM`, `CRM`, `Dify`, `PostHog`, `BNP`, `Twilio`, `Blob`, `S3`, `Slack`

Ask:

- Is this repo the system of record or only a BFF/client?
- Does the knowledge currently attribute this boundary to the wrong repo?

## 7. Compare docs, code, and existing knowledge pages

Cross-check three views:

- repo docs and manifests
- actual implementation folders and routes
- already-existing knowledge pages

Look for:

- same business domain under a renamed controller/module
- existing knowledge pages with stale semantics
- frontend route groups with no backend page
- backend controller groups with no business capability page
- docs that declare a feature not obvious from the first scanned folder

## 8. Verify liveness — filter out dead code and legacy logic

Before promoting any discovered boundary to the knowledge, verify it is actually reachable from a live entry point. Codebases accumulate stale logic that looks like real capabilities but is no longer active.

**For frontend repos**, trace from UI entry points inward:
1. Read the main router config — which routes are actually registered (not commented out)?
2. Read navigation/menu/sidebar components — which items are rendered and visible to users?
3. For each candidate capability, confirm a menu item, button, or link leads to it
4. Check for feature flags, route guards, or conditional rendering that may disable paths
5. Trace API calls from live pages — if a page is reachable but calls a deprecated API, flag it

**For backend repos**, trace from runtime registration inward:
1. Check application startup / DI registration — which services and controllers are wired?
2. Check if scheduled jobs and listeners are registered (not just defined)
3. Look for `@Deprecated`, `// legacy`, `// old`, `// TODO: remove` markers
4. Cross-reference with frontend: if no frontend page calls an endpoint, it may be dead

**Mark each boundary**:
- `LIVE` — reachable from active UI or backend trigger → eligible for knowledge pages
- `SUSPECT` — exists in code but no confirmed live entry point → note as caveat, do not promote to knowledge page

## 9. Apply the materiality filter

Promote only stable knowledge:

- `business_capabilities` for durable operational slices
- `interfaces` for meaningful API/service boundaries
- update existing pages for field-level, filter-level, or caveat-level details

Do not create new top-level taxonomy without explicit user approval.

## 9. Mandatory questions before closing the first pass

You should be able to answer all of these:

- What files define runtime entrypoints?
- What folders define stable capability roots?
- What route/controller groups exist, including anonymous or callback paths?
- What background jobs, scripts, or workers can change state?
- What external services are first-class boundaries?
- What existing knowledge pages might be stale because the same domain moved or broadened?

If any answer is still fuzzy, keep scanning before writing the source page.

## 10. Useful generic grep prompts

These are examples, not mandatory exact commands:

- `rg -n "Route\\(|Http(Get|Post|Put|Delete)|MapControllers|MapGroup|ApiVersion|Authorize|AllowAnonymous" <repo>`
- `rg -n "HostedService|BackgroundService|Scheduled|cron|worker|queue|listener|consumer" <repo>`
- `rg -n "AddHttpClient|FeignClient|axios.create|baseURL|buildApiUrl|VITE_|https?://" <repo>`
- `rg -n "metrics|analytics|posthog|notification|audit|workflow|approval|report" <repo>`
- `rg -n "README|docs|Requirement|Workflow|Process|spec" <repo>`

Use the repo stack to decide which hits matter. The point is to find stable surfaces, not to dump every file.
