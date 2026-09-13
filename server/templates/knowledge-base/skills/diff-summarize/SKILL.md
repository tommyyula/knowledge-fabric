---
name: diff-summarize
description: "Preprocess raw git diffs into structured business change summaries before knowledge ingest. Use this skill between diff capture and ingest to filter out noise (formatting, dependencies, renames) and extract meaningful business changes — additions, modifications, and deletions/deprecations. Produces a clean markdown summary that replaces the raw diff as ingest input."
---

# Diff Summarize

## Overview

Raw git diffs contain a lot of noise: formatting changes, dependency bumps, variable renames, test scaffolding, etc. Ingesting raw diffs directly forces the LLM to sift through hundreds of lines to find the actual business-relevant changes, leading to missed insights and wasted tokens.

This skill sits between diff capture (sync-repos Step 2.5) and ingest (sync-repos Step 3). It reads the raw diff markdown file and produces a structured business change summary.

## Workflow

### Step 1: Load knowledge context

Before reading the diff, build an understanding of what the knowledge already knows about this repo's business domain:

1. Read `knowledge/index.md` to get the full page catalog.
2. Read `knowledge/overview.md` for the cross-source synthesis.
3. Identify the repo name from the diff filename (e.g., `agentcentral-api`), then read the corresponding source page in `knowledge/sources/` if it exists.
4. Find knowledge pages related to this repo by:
   - Scanning `knowledge/index.md` for page titles that relate to the repo's known domain
   - If a source page exists, checking its `sources` slug, then searching other knowledge pages whose `sources` frontmatter references the same slug
   - Following any `[[links]]` found in the source page to load connected `business_capabilities`, `business_objects`, `business_flows`, `rules`, and `interfaces` pages
   - If no source page exists yet (first sync), rely on `knowledge/index.md` and `knowledge/overview.md` alone
5. Build a mental model of: what capabilities this repo is known to provide, what entities it manages, what flows it participates in, what interfaces it exposes, and what rules it enforces.

This knowledge context is the lens through which you interpret the diff. A code change that touches a known business capability is more significant than one that touches an unknown utility. A deletion that removes a documented interface is critical. A new endpoint that doesn't map to any existing knowledge page may signal a new capability.

### Step 2: Read the raw diff

Read the raw diff markdown file from `raw/diff/`. Parse the commit log and diff content.

### Step 3: Classify changes against knowledge context

Scan the diff and classify each changed file/hunk, using the knowledge context from Step 1 to judge relevance:

**Business-relevant** (keep and summarize):
- New or modified API endpoints, routes, controllers — especially those that map to known `interfaces` pages
- Business logic changes in services, models, domain layers — especially those touching known `business_capabilities` or `business_objects`
- Workflow/state machine changes — cross-reference with known `business_flows`
- Database schema changes (migrations, entity definitions) — cross-reference with known `business_objects`
- New or modified business rules, validation logic — cross-reference with known `rules`
- Configuration changes that affect business behavior (feature flags, permissions, role definitions)
- UI changes that introduce or remove user-facing features (new pages, removed menu items, changed forms)
- Job/worker/scheduler changes that affect business processes
- Any change that contradicts or invalidates what the knowledge currently states

**Noise** (skip or mention briefly):
- Code formatting, linting fixes
- Dependency version bumps (unless a major version with breaking changes)
- Pure refactoring with no behavior change (renames, file moves, extract method)
- Test file changes (unless they reveal new business scenarios)
- Build/CI config changes
- Comment-only changes
- Import reordering

### Step 4: Produce business change summary

Write a structured summary markdown file to `raw/diff/` alongside the original, with the suffix `_summary`:

```
raw/diff/<repo-name>_<YYYY-MM-DD>_<old-short>..<new-short>_summary.md
```

The summary file should have this structure:

```markdown
# Business Changes: <repo-name>

- **Date**: YYYY-MM-DD
- **Branch**: <branch>
- **Range**: `<old-short>..<new-short>`
- **Original diff**: `<original-diff-filename>.md`

## New Capabilities / Features

- Description of each new business capability, feature, or endpoint added
- Note whether it maps to an existing knowledge page or is entirely new to the knowledge
- Include the relevant file paths for traceability

## Modified Behavior

- Description of each meaningful behavior change
- What was the old behavior (reference the knowledge page if documented), what is the new behavior
- Flag if the change contradicts what the knowledge currently states: `⚠️ Knowledge says X, code now does Y: [[PageName]]`
- Include the relevant file paths

## Removed / Deprecated

- Description of each removed feature, endpoint, entity, or workflow
- What was removed and what it used to do
- Flag knowledge pages that document the removed functionality: `⚠️ May be stale: [[PageName]]`

## Schema / Data Changes

- New tables, columns, fields, or entity changes
- Migration descriptions
- Flag knowledge `business_objects` pages that may need updating: `⚠️ May affect: [[PageName]]`

## Knowledge Impact

- List of knowledge pages that may need updating based on this changeset
- For each, state why: contradicted, stale, incomplete, or newly relevant

## Summary

2-3 sentence overall summary of the business impact of this changeset, framed against what the knowledge already knows.
```

If a section has no items, omit it entirely.

### Step 4: Return the summary file path

Return the path to the summary file. This file replaces the raw diff as the input to the ingest workflow.

## Decision Rules

- If the entire diff is noise (only formatting, deps, refactoring), produce a minimal summary stating "no business-relevant changes detected" and skip ingest for this diff.
- If the diff is very large (>500 changed files), focus on the top-level structural changes and flag it as needing manual review.
- For the "Removed / Deprecated" section, actively cross-reference against existing knowledge page titles to flag potentially affected pages.
- When in doubt about whether a change is business-relevant, include it — it's better to over-include than to miss a real change.

## Language

- Section headers stay in English as defined above.
- Summary prose should use Simplified Chinese by default, following the knowledge writing style.
- Preserve code identifiers, API paths, class names, file paths in their original form.
