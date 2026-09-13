---
name: batch-ingest
description: Use for ingesting directories with more than 8 eligible files via an ingest plan and batch-by-batch draft updates.
---

# Batch Ingest Skill

## Trigger Condition

This skill is triggered **instead of** the standard ingest workflow when the target directory contains **more than 8 files** (counted recursively, including all nested subdirectories). For 8 files or fewer, use the standard `/knowledge-ingest` workflow.

## Overview

A three-phase workflow for ingesting large directories:

```
Phase 1: Schema Compatibility Preflight
  |
  v
Phase 2: Plan (scan, group, and write the ingest plan)
  |
  v
Phase 3: Execute (batch-by-batch ingest)
```

---

## Status Definitions

| Level | Status | Meaning |
|-------|--------|---------|
| Plan | `in_progress` | Execution ongoing |
| Plan | `completed` | All phases done |
| Batch | `pending` | Not yet started |
| Batch | `success` | Successfully processed |
| Batch | `failed` | Permanently failed after all retries |

---

## Phase 1: Schema Compatibility Preflight

### Input

- User-specified directory path (e.g. `raw/src/`, `raw/prds/`)

This phase runs before the managed ingest runtime. It is for schema judgment and user communication only.

Do not call `knowledge_update_journey`.
Do not create or edit `ingest-plans/`.
Do not call `knowledge_prepare_ingest_draft`.
Do not write `pending_review/drafts/`.
Do not write `verify/`.

### Steps

1. Read and follow `skills/_shared/schema-compatibility-gate.md`.
2. Settle the schema handling for this ingest: either confirm the current schema can be used, or determine the required schema change.
3. After the schema is settled, continue to Phase 2.

## Phase 2: Plan

### Constraint

Do not write draft content during this phase. The only workflow artifact this phase may create or edit is `ingest-plans/<plan-id>.json`.

### Steps

1. **Recursive scan**: Use Glob to list ALL files in the target directory (including nested subdirectories). Only count knowledge-bearing files (source code, documentation, PRDs, markdown, etc.). Exclude configuration files, dependency directories (e.g. `node_modules/`), lock files, and build artifacts. Count total eligible files.
2. **Structural analysis**: Identify natural grouping boundaries:
   - Top-level subdirectories (each service/module = natural batch unit)
   - File types (models, controllers, routes)
   - File relationships (files in same directory are likely related)
3. **Batch shape analysis**: Organize batches around **coherent areas of knowledge**, not file count. Related and cross-referenced documents should stay together. Each batch MUST contain at most 8 files. If one coherent area has more than 8 files, split it into multiple sequential batches with the same semantic prefix, e.g. `Data Tables Set A`, `Data Tables Set B`, `Data Tables Set C`.
4. **Generate run identity and plan file**: Derive `<directory-slug>` from the source name or directory basename. The slug MUST be lowercase ASCII and may contain only `a-z`, `0-9`, `.`, `_`, and `-`: lowercase it, replace every character outside `[a-z0-9._-]` with `-`, collapse repeated `-`, and trim leading/trailing `-`, `_`, and `.`. If the result is empty, use `source`. Never preserve spaces, parentheses, quotes, slashes, Chinese punctuation, or other symbols in `<directory-slug>`. Generate one run ID `<directory-slug>-<YYYY-MM-DD>-<4hex>`. Use it as `plan_id`, set `draft_id` to `ingest-<run-id>`, verify both match `^[A-Za-z0-9._-]+$`, verify the plan file path is exactly `ingest-plans/<plan-id>.json`, then write `ingest-plans/<plan-id>.json`.
   - The plan file MUST include `source_name` derived by the Source Name Rule.
   - `plan_id` is only for tracking the ingest plan and MUST NOT be used as the source page filename.
   - If any ID validation fails, regenerate a valid run ID before writing the plan file. Never write a plan file for a rejected or invalid draft ID.
5. **Immediately proceed** to Phase 3 — no user confirmation needed.

### Plan File Schema

```json
{
  "plan_id": "<directory-slug>-<YYYY-MM-DD>-<4hex>",
  "draft_id": "ingest-<directory-slug>-<YYYY-MM-DD>-<4hex>",
  "source_name": "<user-readable source name>",
  "created_at": "YYYY-MM-DD HH:mm",
  "target_directory": "raw/src/",
  "total_files": 34,
  "total_batches": 5,
  "status": "in_progress",
  "batches": [
    {
      "id": "batch-1",
      "label": "Core Models",
      "description": "基础业务模型 — Order, Product, User",
      "files": [
        "raw/src/order-service/models/order.ts",
        "raw/src/order-service/models/order-item.ts",
        "raw/src/product-service/models/product.ts",
        "raw/src/user-service/models/user.ts"
      ],
      "status": "pending"
    },
    {
      "id": "batch-2",
      "label": "Order Service APIs",
      "description": "订单服务接口层 — controllers + routes",
      "files": [
        "raw/src/order-service/controllers/order.controller.ts",
        "raw/src/order-service/routes/order.routes.ts"
      ],
      "status": "pending"
    }
  ]
}
```

---

## Phase 3: Execute

Run Batch Ingest in the main agent only. Do not use the Agent tool or sub-agents during Execute.

### Setup

Before processing any batch, create a single draft for the entire ingest:
- Read `draft_id` from the ingest plan. Do not generate another ID.
- Call `knowledge_prepare_ingest_draft` with `draft_id=<draft-id>`. This backend tool first validates the saved ingest plan, then byte-copies current `knowledge/index.md`, `knowledge/overview.md`, `knowledge/glossary.md`, and `knowledge/log.md` into `pending_review/drafts/<draft-id>/knowledge/` as the starting point. If the tool rejects the plan, regenerate a valid plan and retry before writing any draft content.
- Do not recreate those baseline files by reading `knowledge/index.md`, `knowledge/overview.md`, `knowledge/glossary.md`, or `knowledge/log.md` and writing them yourself. After `knowledge_prepare_ingest_draft` succeeds, read and edit only the draft copies.

All batches write into this single draft. Each batch builds on top of what previous batches have already written. Do not write `meta.json` until Verify passes.
Use workspace-relative file paths only. Never use absolute server paths such as `/app/data/...`; write files as `pending_review/drafts/<draft-id>/knowledge/...`.


### Steps

Execute the saved ingest plan one batch at a time, strictly in the `batches` array order.

Before each batch, re-read `ingest-plans/<plan-id>.json` and select the first batch whose `status` is `pending`. Treat that selected batch as the current batch. Start with `batch-1`, then continue batch by batch in order. Run the steps below only for files listed in the current batch's `files` array. Do not skip ahead, sample files, or process files outside the current batch.

For the current batch:

1. Read all source documents in the batch fully.
2. Read the draft's current `index.md`, `overview.md`, and `glossary.md` (these accumulate across batches).
3. Update the draft's `index.md` using the Index Format below.
4. Update the draft's `overview.md` — revise synthesis if warranted.
5. Update the draft's `glossary.md` when this batch introduces or clarifies company-, business-, or project-specific terms that are not covered by general industry usage — use the Glossary Format below.
6. Update or create knowledge pages in the draft as needed:
   {{KNOWLEDGE_SUBDIRS_LIST}}
   For each target page type, must read the matching or closest contract from the Contracts Index below before updating or creating pages. Follow the contract as the target page structure; do not read unrelated contracts.
   Do not create `knowledge/sources/*` pages during per-batch execution; batches are processing units only. Write exactly one aggregate source page `knowledge/sources/<source_name>.md` in Finalize.
7. **接口路径验证**（仅当本次 ingest 新增或修改了 interfaces 页面时）— 回到源码确认 class-level 路由前缀与 method-level 路径已正确拼接为完整相对路径，验证 `### 标题`、`Key Endpoints`、`Authentication` 三处路径引用一致
8. Flag any contradictions with existing knowledge content
9. **Lite lint** — read and follow `skills/_shared/ingest-quality-gate.md`; check for broken `[[links]]` and missing `index.md` entries introduced by this batch; fix them immediately
10. **Update plan**: Confirm every source file in the current batch is represented in the draft knowledge. Then mark only the current batch status as `success` in the plan file. Never mark later batches as `success` before processing them. Re-read the saved plan and confirm the current batch is `success` while unprocessed later batches remain `pending`. Do this before moving on to the next batch. If the current batch is still `pending`, fix the plan file first.
11. **Continue immediately**: If any batch is still `pending`, start the next batch right away with tool calls. Do not end the assistant turn just because one batch has completed.

### Finalize

After all batches have been processed (no `pending` remaining):

1. Write exactly one aggregate source page in the draft: `sources/<source-name>.md`.
   - Use `source_name` from the ingest plan.
   - Do NOT use `plan_id` as the source page filename.
   - Use the Source Name Rule and Source Page Format below.
   - This source page represents the entire batch ingest run, not a single raw file and not a single batch.
   - Set `source_file` to the target directory, such as `raw/`.
   - Summarize the full ingest scope, key claims, generated knowledge pages, gaps, and contradictions.
   - Do not create source pages per raw file or per batch.
2. Append to the draft's `log.md` using the Log Format below
3. Call `knowledge_update_journey` with `status=done`, `awaitingUser=false`, `build_phase=verify`, `claude_workflow=verify`.
4. Read and follow `skills/verify/SKILL.md`.
5. Run:
```text
verify <target-directory> pending_review/drafts/<draft-id>/knowledge ingest-plans/<plan-id>.json
```
6. Only after Verify fully passes, write `pending_review/drafts/<draft-id>/meta.json`; Review must not start without it.

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
7. Update plan status to completed.
8. Call knowledge_update_journey with status=done, awaitingUser=false, and build_phase=review.
9. Do not write a user-facing Review-ready message in chat. The backend reads the actual pending review draft and reports the localized Review-ready message with the correct file count.

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

### Language Rule

- Frontmatter fields (`title`, `type`, `tags`, etc.) and section headings must be in English
- Page content (summaries, claims, descriptions, connections) must be written in {{CONTENT_LANGUAGE}}


### Page Format

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

#### Naming Conventions
- Source slugs: `kebab-case` matching source filename
{{KNOWLEDGE_NAMING_CONVENTIONS}}  # Auto-populated by bootstrap — one line per directory from {{KNOWLEDGE_SUBDIRS}}, e.g. "- <Type> pages: `TitleCase.md` (e.g. `ExampleTitle.md`)"
- Source pages: `kebab-case.md`

#### Required Content Sections by Type

Use the page type to find and follow the matching contract in the Contracts Index.

### Glossary Format

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

### Source Name Rule

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
- `knowledge/sources/<source-name>.md`
- the source page frontmatter `title`
- `meta.json` source page references
- `index.md` Sources entry

### Source Page Format

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

### Index Format

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

---

## Error Handling

### Batch-level errors

- If a batch fails mid-execution, auto-retry up to **3 times** immediately
- If still fails after 3 retries, mark status as `failed` in the plan file, skip it, and continue with remaining batches
- Report failed batches to user after all execution is complete.
