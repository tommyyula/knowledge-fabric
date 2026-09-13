# Codebase Ingest Map

## Overview

Use this reference before the first-pass knowledge ingest for any raw source that is substantively a repository snapshot or codebase folder. Its job is to prevent a folder-level or class-level skim from becoming the effective system model.

The goal is to build a **repo surface map** first, then write knowledge pages from that map.

This is an internal planning subroutine for `coding-repo-ingest`. When invoked by the owning ingest workflow, do not write files, do not produce a user-facing response, and do not end the assistant turn. Keep the repo surface map as working context and return immediately to the next `coding-repo-ingest` Build Draft step.

## Workflow

1. Read the repo frame first: `README`, repo-local `AGENTS.md` / `CLAUDE.md`, `docs/`, and the main build/manifests.
2. Identify the stack and load `references/repo-surface-scan-order.md`.
3. Build a scratch repo map that covers:
   - runtime entrypoints and wiring
   - stable module roots
   - controller/router/API boundaries
   - background jobs, scripts, workers, listeners, scheduled tasks
   - external clients and third-party dependencies
   - config/env/migration surfaces that imply business logic
   - naming drift versus already-existing knowledge pages
4. Only after the repo map exists should the owning `coding-repo-ingest` workflow write or revise knowledge pages.
5. After the owning ingest has written the first draft knowledge pass, it will read and follow `references/post-repo-ingest-gap-check.md`.

## Decision Rules

- This reference is used only when the backend has validated a `raw/repos/<id>` target as a code repository.
- Do not use this reference for non-raw/repos sources, even if they contain scripts or code-like files.
- If the backend says a `raw/repos/<id>` target is document material, do not use this reference; route to single-ingest or batch-ingest by file count.
- If the raw source is a backend-validated GitHub/Bitbucket repo snapshot, cloned repo, or monorepo package under `raw/repos/<id>`, use this skill first.
- A `services/` sweep is never sufficient by itself.
- A `controllers/` sweep is also insufficient by itself; many stable capabilities live in routing, job runners, BFFs, docs, config, or scripts.
- If a stable business boundary appears only in docs, config, background jobs, or API client code, it still counts.
- If an existing knowledge page seems related, verify the current repo semantics before reusing it. Name continuity does not imply semantic continuity.
- Small route groups, prototype endpoints, or BFF aggregations should usually be documented as caveats or interface extensions, not automatically promoted into a new platform.

## Dead Code & Legacy Logic Detection

Codebases accumulate stale logic over time — old API clients, deprecated routes, unused services, commented-out features, and legacy flows that are no longer reachable from any live UI path. These MUST NOT enter the knowledge as current capabilities.

**Liveness principle**: a code path is "live" only if it is reachable from an active UI entry point (menu item, navigation route, button, link) or an active backend trigger (scheduler, event listener, webhook). Code that merely exists in the repo is not evidence of a current capability.

**How to verify liveness for frontend repos**:
1. Trace from router config → which routes are registered and not commented out
2. Trace from navigation/menu components → which menu items are rendered and visible
3. Trace from page components → which API calls they actually make
4. Check if route guards or feature flags disable certain paths

**How to verify liveness for backend repos**:
1. Trace from controller registrations → which endpoints are wired into the runtime
2. Check if services are actually injected and called by live controllers
3. Check if scheduled jobs / listeners are registered in the application startup
4. Look for `@Deprecated`, `// TODO: remove`, `// legacy`, `// old` annotations

**Red flags for dead code**:
- API client methods with zero callers in the frontend
- Routes defined in config but not linked from any menu or navigation
- Services registered but never injected
- Controllers with endpoints that no frontend page calls
- Entire modules imported but gated behind always-false feature flags
- Code paths that reference removed or renamed external services

When building the repo surface map, mark each discovered boundary as `LIVE` or `SUSPECT`. Only `LIVE` boundaries should become knowledge pages. `SUSPECT` items should be noted in the source page's Contradictions or caveats section, not promoted to standalone pages.

If an existing knowledge page appears to cover a capability but the current repo proves its route, controller, job, listener, or caller is no longer live, mark that boundary as `SUSPECT` in the repo surface map. The owning `coding-repo-ingest` run must not reuse the old page as current evidence until the post-repo ingest gap check has demoted or corrected the draft claim.

## Internal Readiness Check

Before returning to the owning `coding-repo-ingest` Build Draft workflow, you should be able to answer the questions below. Do not output these answers to the user unless the user explicitly asked for a standalone repo map.

- What are the runtime entrypoints?
- What are the stable business/module roots?
- What interfaces or route groups exist?
- What external systems are first-class boundaries?
- What scripts, jobs, or workers can mutate business state?
- What old knowledge pages may need provenance refresh instead of new page creation?

## Resources

- Always read `references/repo-surface-scan-order.md` for codebase ingests.
