# Post-Repo-Ingest Checklist

Use this checklist after every `coding-repo-ingest` run.

## 1. Re-open the repo knowledge delta

- Read the new draft source page.
- Read `pending_review/drafts/<draft-id>/knowledge/index.md` and `pending_review/drafts/<draft-id>/knowledge/overview.md`.
- Read every draft business/interface page touched during the repo ingest.
- Re-open the repo surface map from the owning `coding-repo-ingest` run and compare against that map, not against the first folder that happened to be scanned.
- Ask: "What did the repo ingest claim this source contains?"

## 2. Scan for hidden frontend structure

Search for:

- router modules
- nested child routes
- route meta titles
- view directories that were not mentioned in the source page
- locale keys that expose feature names
- README or `CLAUDE.md` feature lists

Typical grep targets:

- `src/app/router/routers/modules`
- `src/app/views`
- `src/locales`
- `README`
- `CLAUDE.md`

## 3. Scan for hidden backend or service boundaries

Search for:

- API clients under `apis/`
- `buildApiUrl`
- environment-based base URLs
- `VITE_` variables
- external hostnames
- controllers or services with analytics, metrics, notification, reporting, or audit semantics
- scripts, workers, listeners, cron jobs, or hosted/background services
- callbacks, auth routes, webhook routes, and other small route groups easy to skip

Ask:

- Is the page calling a local backend controller or an external service?
- Did the ingest only document the local controller set and miss a frontend-direct service?

## 4. Look for high-risk labels

Treat these names as suspicious until verified:

- `dashboard`
- `admin-dashboard`
- `analytics`
- `discover`
- `notification-management`
- `settings`
- `reports`
- `statistics`
- `usage`
- `overview`

These names often hide real capabilities behind generic labels.

## 5. Compare cross-layer semantics

- Compare frontend route/module names with backend controller names.
- Compare UI labels with source page claims.
- Compare environment-switched APIs with local service assumptions.
- Compare feature lists in docs with actual implementation folders.
- When interface boundaries are present, read `interface-boundary-audit.md` for the dedicated controller/API/MCP/API-client coverage pass and endpoint path validation.

Ask:

- Is there a stable capability that appears in frontend structure but not in knowledge taxonomy?
- Is there an interface boundary that exists only in frontend API code?
- Is a child route incorrectly absorbed into a parent capability?

## 6. Apply materiality filter

Create or update draft knowledge pages under `pending_review/drafts/<draft-id>/knowledge/` only for stable live knowledge:

- `pending_review/drafts/<draft-id>/knowledge/business_capabilities/` for real operational slices
- `pending_review/drafts/<draft-id>/knowledge/interfaces/` for meaningful API/service boundaries
- existing pages for fields, filters, caveats, and detail-level rules

Do not create new top-level taxonomy without explicit user approval.

## 7. Patch the draft knowledge

If a gap is confirmed:

- update the source page
- update `pending_review/drafts/<draft-id>/knowledge/index.md`
- update `pending_review/drafts/<draft-id>/knowledge/overview.md` if the platform picture changed
- update or create the relevant business/interface pages
- append `pending_review/drafts/<draft-id>/knowledge/log.md` with the supplement reason

All paths above refer to files inside the active draft at `pending_review/drafts/<draft-id>/knowledge/`. Do not read, update, or create root `knowledge/` files from this checklist.

## 8. Explain the miss

In the final answer for the owning ingest workflow, say:

- what was missed
- why it was easy to miss
- what was added or updated
- what still cannot be confirmed from the current source set

## 9. Verify liveness and reject dead code from knowledge

After identifying gaps, verify each candidate is actually live before adding it to the knowledge.

Liveness principle: a code path is live only if it is reachable from an active UI entry point such as menu, nav, or button, or an active backend trigger such as scheduler, listener, or webhook. Code that merely exists in the repo is not a current capability.

Check for:

- Routes defined but not linked from any menu or navigation component
- API client methods with zero callers in the frontend
- Services defined but never injected into live controllers
- Endpoints that no frontend page calls
- Modules gated behind always-false feature flags
- Code annotated with `@Deprecated`, `// legacy`, `// old`, or `// TODO: remove`

If a gap-check candidate turns out to be dead code:

- Do not create a knowledge page for it
- Note it in the source page's Contradictions section as legacy/deprecated logic
- Mention it in the final answer as "found but confirmed dead"

If an existing draft page inherited a capability claim that the current repo proves is not live:

- Do not leave the claim in the main current-state sections
- Demote it to a `Deprecated`, `Caveats`, or `Contradictions` section with the source evidence
- Add `deprecated: true` only when the whole draft page describes non-live behavior
- Update `pending_review/drafts/<draft-id>/knowledge/index.md`, `pending_review/drafts/<draft-id>/knowledge/overview.md`, and `pending_review/drafts/<draft-id>/knowledge/log.md` if the demotion changes the knowledge map

## 10. Default explanation patterns

Common reasons:

- nested route under another module
- external API not present in local backend repo
- generic menu name hid a distinct capability
- first-pass ingest focused on documented domains and skipped adjacent modules
- frontend and backend naming drift masked the connection
- controller/service sweep missed logic living in jobs, scripts, callbacks, config, or docs
- an old knowledge page looked already covered even though the new repo broadened that boundary
