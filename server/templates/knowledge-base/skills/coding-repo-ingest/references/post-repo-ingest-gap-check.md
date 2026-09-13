# Repo Ingest Gap Check

## Overview

Run a repo-specific post-ingest gap audit before considering a code repository ingest complete. Focus on finding live capabilities, interfaces, routes, endpoint path mismatches, external service dependencies, background triggers, and nested modules that were easy to miss during the first pass.

This reference is scoped to backend-validated code repositories under `raw/repos/<id>`. If the source is document material, stop and return to the owning `single-ingest` or `batch-ingest` workflow instead of adapting this checklist.

## Workflow

0. Confirm the source is a backend-validated code repository under `raw/repos/<id>` and the current changes are being written inside the active draft under `pending_review/drafts/<draft-id>/knowledge/`.
1. Confirm the owning `coding-repo-ingest` run already read and followed `references/repo-surface-map.md`. If the repo surface map is missing or too incomplete to pass that reference's Internal Readiness Check, return to the `coding-repo-ingest` Build Draft step that calls it before auditing; do not compensate by building the map inside this post-check.
2. Read the draft's newly updated source page, `pending_review/drafts/<draft-id>/knowledge/index.md`, `pending_review/drafts/<draft-id>/knowledge/overview.md`, and the business/interface pages touched by the repo ingest under `pending_review/drafts/<draft-id>/knowledge/`.
3. Compare the draft knowledge coverage against the ingested repository itself and the repo surface map. Do not trust the first-pass summary alone.
4. Look for coverage gaps using the checklist in `references/post-repo-ingest-checklist.md`.
5. If the repo surface map or draft contains controller, router, API, MCP, webhook, frontend API-client, or `pending_review/drafts/<draft-id>/knowledge/interfaces/` changes, read and follow `references/interface-boundary-audit.md` as the Interface Boundary Coverage Pass.
6. If a missed item is a stable live module, workflow, object, rule, or interface boundary, update the draft knowledge immediately.
7. If a missed item is real but does not justify a new page, capture it in the most relevant existing draft page as a note, connection, contradiction, or source claim.
8. Update `pending_review/drafts/<draft-id>/knowledge/index.md`, `pending_review/drafts/<draft-id>/knowledge/overview.md`, and `pending_review/drafts/<draft-id>/knowledge/log.md` when the audit changes the top-level picture.
9. In the final response for the owning ingest workflow, state what was missed, why it was easy to miss, and what was added or updated.

## High-Risk Miss Patterns

- Nested child routes under an existing menu such as `/user-management/admin-dashboard`
- Frontend pages that call external services instead of the local backend
- Features listed in README, `CLAUDE.md`, locale files, or route metadata but not reflected in knowledge pages
- Modules hidden inside generic names such as `dashboard`, `discover`, `analytics`, `settings`, or `management`
- Capability boundaries that appear only after comparing frontend route structure with backend interfaces
- Label drift where UI names and backend/service names differ enough to hide the same feature
- Runtime logic hidden in jobs, workers, scripts, listeners, or migrations outside `controllers/` and `services/`
- Existing knowledge pages that look related by name, but whose controller semantics have drifted in the newly ingested repo
- Prototype or BFF route groups that are small in code but still materially change the interface picture
- Interface pages whose endpoint headings, `Key Endpoints`, or `Authentication` paths disagree with source route prefixes
- Dead code masquerading as live capabilities: API clients, routes, or services that exist in the codebase but are not reachable from any active UI entry point or backend trigger

## Decision Rules

- Create a new `business_capabilities` page when the missed item represents a stable operational slice, not just a tab or one-off widget.
- Create a new `interfaces` page when the missed item introduces a meaningful external or controller-level boundary.
- Update an existing page instead of creating a new one when the missed item is a detail, filter, field rule, or caveat inside an already documented capability.
- Validate endpoint path composition for any draft interface page created or modified during repo ingest or gap check.
- Record the reason for the miss in `pending_review/drafts/<draft-id>/knowledge/log.md` when it reveals a repeatable repo-ingest blind spot.
- Never promote dead or legacy code to a knowledge page. If a gap-check candidate is not reachable from a live UI path or active backend trigger, note it as deprecated/legacy in the source page's Contradictions section instead.

## Resources

Read `references/post-repo-ingest-checklist.md` when performing the audit. It contains the concrete scan order and grep targets for hidden routes, external APIs, feature manifests, cross-layer mismatch detection, and liveness checks.

Read `references/interface-boundary-audit.md` when the repo or draft contains controller, router, API, MCP, webhook, frontend API-client, or interface-page changes. It contains the detailed scan patterns, coverage classification rules, and endpoint path validation checks for interface boundaries.
