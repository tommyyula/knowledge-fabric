---
name: coding-repo-ingest
description: Use only for backend-validated code repository targets under `raw/repos/{id}`.
---

# Coding Repo Ingest Skill

## Trigger Condition

This skill is triggered by *"ingest <repo>"* or `/knowledge-ingest` only when the backend has validated the target as a **code repository under `raw/repos/<id>`**.

Do not use this skill for non-raw/repos sources, even if they contain scripts or code-like files. If the backend says a `raw/repos/<id>` target is document material, route by file count to `skills/single-ingest/SKILL.md` or `skills/batch-ingest/SKILL.md`.

---

## Steps

### Schema Compatibility Preflight

This phase runs before the managed ingest runtime. It is for schema judgment and user communication only.

Do not call `knowledge_update_journey`.
Do not create or edit `ingest-plans/`.
Do not call `knowledge_prepare_ingest_draft`.
Do not write `pending_review/drafts/`.
Do not write `verify/`.

1. Read and follow `skills/_shared/schema-compatibility-gate.md`.
2. Settle the schema handling for this ingest: either confirm the current schema can be used, or determine the required schema change.
3. After the schema is settled, continue to Draft Setup.

Run Coding Repo Ingest in the main agent only. Do not use the Agent tool or sub-agents during ingest.

### Draft Setup

1. Derive `<source-name>` using the Source Name Rule below.
2. Derive `<source-slug>` from `<source-name>` or the source path basename. The slug MUST be lowercase ASCII and may contain only `a-z`, `0-9`, `.`, `_`, and `-`: lowercase it, replace every character outside `[a-z0-9._-]` with `-`, collapse repeated `-`, and trim leading/trailing `-`, `_`, and `.`. If the result is empty, use `source`. Never preserve spaces, parentheses, quotes, slashes, Chinese punctuation, or other symbols in `<source-slug>`.
3. Generate one run ID: `<source-slug>-<YYYY-MM-DD>-<4-char-hex>`. Set plan ID to the run ID and draft ID to `ingest-<run-id>`. Reuse these exact IDs for the entire ingest; do not generate separate random suffixes.
4. Confirm the linked IDs before writing anything: plan ID is `<run-id>`, draft ID is `ingest-<run-id>`, both match `^[A-Za-z0-9._-]+$`, and the plan file path is exactly `ingest-plans/<plan-id>.json`.
5. Create `ingest-plans/<plan-id>.json` using the same plan schema as Batch Ingest, with exactly one batch scoped to the repository root:

   ```json
   {
     "plan_id": "<plan-id>",
     "draft_id": "<draft-id>",
     "source_name": "<source-name>",
     "created_at": "YYYY-MM-DD HH:mm",
     "target_directory": "raw/repos/<repo-resource-id>",
     "total_files": 1,
     "total_batches": 1,
     "status": "in_progress",
     "batches": [
       {
         "id": "batch-1",
         "label": "<source-name>",
         "description": "Repository root scope",
         "files": [
           "raw/repos/<repo-resource-id>"
         ],
         "status": "pending"
       }
     ]
   }
   ```

   `source_name` and `batches[0].label` MUST be the same `<source-name>` derived by the Source Name Rule. Do not use `<plan-id>` or `<draft-id>` as `source_name`.

6. Call `knowledge_prepare_ingest_draft` with `draft_id=<draft-id>`. This backend tool first validates the saved ingest plan, then byte-copies current `knowledge/index.md`, `knowledge/overview.md`, `knowledge/glossary.md`, and `knowledge/log.md` into `pending_review/drafts/<draft-id>/knowledge/` as the starting point. Wait for this tool to succeed before writing draft content. If it rejects the draft ID or plan, regenerate a valid plan and do not write any draft content using the rejected ID.
7. Do not recreate those baseline files by reading `knowledge/index.md`, `knowledge/overview.md`, `knowledge/glossary.md`, or `knowledge/log.md` and writing them yourself. After `knowledge_prepare_ingest_draft` succeeds, read and edit only the draft copies.

All knowledge changes in this ingest must be written to the draft, mirroring the `knowledge/` structure. Do not write `meta.json` until Verify passes.
Use workspace-relative file paths only. Never use absolute server paths such as `/app/data/...`; write files as `pending_review/drafts/<draft-id>/knowledge/...`.

### Build Draft

1. Read and follow `skills/coding-repo-ingest/references/repo-surface-map.md` as an internal planning sub-step before writing or revising any draft knowledge page; do not stop, summarize, or respond after building the map. Use the resulting repo surface map to guide source reading instead of relying on a directory-level or class-level skim, then continue immediately with the next Build Draft step.
2. Read the draft's `knowledge/index.md` and `knowledge/overview.md` for current knowledge context
3. Read the draft's `knowledge/glossary.md` as the shared terminology page for this knowledge base.
4. Write the draft's `knowledge/sources/<source-name>.md` — use the Source Name Rule and Source Page Format below, and summarize the repo surface map rather than individual files
5. Update the draft's `knowledge/index.md` using the Index Format below
6. Update the draft's `knowledge/overview.md` — revise synthesis if warranted
7. Update the draft's `knowledge/glossary.md` when the source introduces or clarifies company-, business-, or project-specific terms that are not covered by general industry usage — use the Glossary Format below.
8. Update or create knowledge pages as needed (follow Liveness Rule for codebase sources):
   {{KNOWLEDGE_SUBDIRS_LIST}}
   For each target page type, read the matching or closest contract from the Contracts Index below before updating or creating pages. Follow the contract as the target page structure; do not read unrelated contracts.
9. Flag any contradictions with existing knowledge content
10. Read and follow `skills/coding-repo-ingest/references/post-repo-ingest-gap-check.md` — audit repo knowledge coverage for missed live modules, routes, interfaces, endpoint paths, or boundaries
11. Append to the draft's `knowledge/log.md` using the Log Format below
12. **Lite lint** — read and follow `skills/_shared/ingest-quality-gate.md`; check for broken `[[links]]` and missing `index.md` entries introduced by this ingest; fix them immediately
13. Update `ingest-plans/<plan-id>.json`: mark `batches[0].status` as `success`, then confirm the saved plan shows `batch-1` as `success`.
14. Continue immediately to Verify Gate. Do not stop, summarize, or ask the user to continue.

#### Liveness Rule for codebase sources

When ingesting repos, only document capabilities that are reachable from live entry points — menu items, navigation routes, buttons, scheduled jobs, or event listeners. Code that merely exists in the repo but has no active caller is dead code and must NOT become a knowledge page. Note dead/legacy logic in the source page's Contradictions section instead.

---

### Verify Gate

1. Call `knowledge_update_journey` with `status=done`, `awaitingUser=false`, `build_phase=verify`, `claude_workflow=verify`.
2. Read and follow `skills/verify/SKILL.md`.
3. Run:

   ```text
   verify <source-path> pending_review/drafts/<draft-id>/knowledge ingest-plans/<plan-id>.json
   ```
4. Only after Verify fully passes, write `pending_review/drafts/<draft-id>/meta.json`; Review must not start without it.

Before writing`meta.json`, inspect `pending_review/drafts/<draft-id>/knowledge/`. Write meta.json with this structure (write `affected_files`, `new_files`, and `modified_files` from the actual draft Markdown files, so every changed file is included): 

   ```json
   {
      "id": "<draft-id>",
      "operation": "ingest",
      "description": "简短描述本次变更",
      "source_file": "<source-path>",
      "affected_files": ["knowledge/sources/<source-name>.md", "knowledge/index.md", "knowledge/overview.md", "knowledge/glossary.md", "knowledge/<page-type>/<new-page>.md", "knowledge/<page-type>/<existing-page>.md", "knowledge/log.md"],
      "new_files": ["knowledge/sources/<source-name>.md", "knowledge/<page-type>/<new-page>.md"],
      "modified_files": ["knowledge/index.md", "knowledge/overview.md", "knowledge/glossary.md", "knowledge/<page-type>/<existing-page>.md", "knowledge/log.md"],
      "log_entry": "## [YYYY-MM-DD] ingest | Title"
   }
   ```

5. Update `ingest-plans/<plan-id>.json`: set `status` to `completed`.

6. Call knowledge_update_journey with status=done, awaitingUser=false, and build_phase=review.

7. Do not write a user-facing Review-ready message in chat. The backend reads the actual pending review draft and reports the localized Review-ready message with the correct file count.

---

## Contracts Index

| Page type | Contract |
|---|---|
| `business_capabilities` | `skills/_shared/contracts/business_capabilities.md` |
| `business_flows` | `skills/_shared/contracts/business_flows.md` |
| `business_objects` | `skills/_shared/contracts/business_objects.md` |
| `interfaces` | `skills/_shared/contracts/interfaces.md` |
| `rules` | `skills/_shared/contracts/rules.md` |
| `data_tables` | `skills/_shared/contracts/data_tables.md` |
| `scenarios` | `skills/_shared/contracts/scenarios.md` |
| `policies` | `skills/_shared/contracts/policies.md` |
| `business_semantics` | `skills/_shared/contracts/business_semantics.md` |
| `templates` | `skills/_shared/contracts/templates.md` |
| `milestones` | `skills/_shared/contracts/milestones.md` |
| `decisions` | `skills/_shared/contracts/decisions.md` |
| `stakeholders` | `skills/_shared/contracts/stakeholders.md` |
| `deliverables` | `skills/_shared/contracts/deliverables.md` |
| `risks` | `skills/_shared/contracts/risks.md` |
| `concepts` | `skills/_shared/contracts/concepts.md` |
| `notes` | `skills/_shared/contracts/notes.md` |
| `references` | `skills/_shared/contracts/references.md` |
| `claims` | `skills/_shared/contracts/claims.md` |
| `preferences` | `skills/_shared/contracts/preferences.md` |
| `routines` | `skills/_shared/contracts/routines.md` |
| `logs` | `skills/_shared/contracts/logs.md` |
| `checklists` | `skills/_shared/contracts/checklists.md` |

---

## Language Rule

- Frontmatter fields (`title`, `type`, `tags`, etc.) and section headings (`## Summary`, `## Key Claims`, etc.) must be in English
- Page content (summaries, claims, descriptions, connections) must be written in {{CONTENT_LANGUAGE}}

---

## Glossary Format

Entries are sorted alphabetically by their heading. The heading is the term's most commonly used name (whether that's an abbreviation or full form):

```
## Term

Aliases: AliasOne, AliasTwo, AliasThree

Definition:
```

Rules:
- Heading = the name most frequently used in daily work, regardless of whether it's an abbreviation or full form
- Aliases = all other ways to refer to the same thing — full name, short form, other languages, informal names. Comma-separated on a single line.
- If there are no aliases, leave `Aliases:` empty; do not write `None`, `N/A`, or similar placeholders.
- Description must capture business meaning, not just a dictionary definition. Max two sentences.
- Only include terms not recognizable from general industry knowledge
- If a concept needs more than two sentences to explain, create a dedicated knowledge page and link to it from here

---

## Page Format

Every knowledge page uses this frontmatter:

```yaml
---
title: "Page Title"
type: sources | {{KNOWLEDGE_SUBDIRS_TYPES}} | syntheses
tags: []
sources: []
last_updated: YYYY-MM-DD
---
```

Use [[PageName]] links to link between pages.
Here, `PageName` means the exact Markdown filename without `.md`, following the Naming Conventions. It is not the frontmatter `title` unless the title is exactly the same as the filename stem.

Example:
- Target file: `knowledge/business_semantics/InventoryAndSupplySemantics.md`
- Correct link: `[[InventoryAndSupplySemantics]]`
- Incorrect link: `[[Inventory and Supply Semantics]]`

### Naming Conventions
- Source slugs: `kebab-case` matching source filename
{{KNOWLEDGE_NAMING_CONVENTIONS}}  # Auto-populated by bootstrap — one line per directory from {{KNOWLEDGE_SUBDIRS}}, e.g. "- <Type> pages: `TitleCase.md` (e.g. `ExampleTitle.md`)"
- Source pages: `kebab-case.md`

### Required Content Sections by Type

Use the page type to find and follow the matching contract in the Contracts Index.

---

## Source Name Rule

Before writing the source page, derive `<source-name>` for this ingest.

`<source-name>` MUST be a user-readable name representing the source material set being ingested. It MUST NOT be a system tracking id.

Derive it in this order:

1. If the ingest target is a directory with exactly one top-level source folder, use that folder name exactly.
   Example: `raw/Logi_Small/...` -> `Logi_Small`.

2. If the ingest target came from a zip archive and the extracted files do not have one clear top-level folder, use the zip file basename.
   Example: `Logi_Small.zip` -> `Logi_Small`.

3. If the ingest target is a single file, use the file basename without extension.
   Example: `raw/AP_ORDER_POC方案V1.3.docx` -> `AP_ORDER_POC方案V1.3`.

4. If the ingest target contains multiple loose files or multiple top-level folders, generate a concise business-readable name from file names, folder names, and source content.
   Example: `Lenovo_Logistics_Assistant`.

Preserve meaningful casing, underscores, hyphens, numbers, and domain terms. Replace only path separators or filesystem-unsafe characters.

Forbidden source names:
- raw
- batch
- batch-1
- plan
- plan-id
- uploaded-files
- source-set
- any value ending with a generated date/hash pattern such as `raw-2026-07-13-a4e1`

Use this `<source-name>` consistently for:
- `ingest-plans/<plan-id>.json` `source_name`
- `ingest-plans/<plan-id>.json` `batches[0].label`
- `knowledge/sources/<source-name>.md`
- the source page frontmatter `title`
- `meta.json` source page references
- `index.md` Sources entry

---

## Source Page Format

```markdown
---
title: "Source Title"
type: sources
tags: []
date: YYYY-MM-DD
source_file: raw/...
---

## Summary
2-4 句摘要。

## Key Claims
- 要点 1
- 要点 2

## Key Quotes
> "原文引用" — 上下文

## Connections
- [[PageName]] — 关联说明

## Contradictions
- 与 [[OtherPage]] 在以下方面存在矛盾: ...
```

---

## Index Format

```markdown
# Knowledge Index

## Overview
- [Overview](overview.md) — living synthesis

- [Glossary](glossary.md) — company, business, or project-specific terms not covered by industry-standard usage

## Sources
- [Source Title](sources/slug.md) — one-line summary

{{KNOWLEDGE_INDEX_SECTIONS}}    # One section per directory from {{KNOWLEDGE_SUBDIRS}}, format: ## Title\n- [Name](dir/Name.md) — description

## Syntheses
- [Analysis Title](syntheses/slug.md) — what question it answers
```

---


## Log Format

Each entry starts with `## [YYYY-MM-DD] <operation> | <title>` so it's grep-parseable:

```
grep "^## \[" knowledge/log.md | tail -10
```
Operations: `ingest`, `query`, `graph`, `challenge`
