---
name: knowledge-edit
description: Handle explicit user-requested knowledge changes, including additions, edits, deletions, corrections, and renames.
---

# Knowledge Edit

Use this when the user asks to add, modify, delete, correct, rename, or update content under `knowledge/`.

Do not use this skill for `ontology/` changes.

Do not use this skill to revise content that is already in the active Review draft. If the user is looking at the Review panel, references a file from that panel, mentions a pending draft, or targets `pending_review/drafts/...`, stop and read `skills/review-draft-edit/SKILL.md` instead.

The user's edit request is permission to stage the change now. Do not explain internal paths or wait for "continue".

Ask one brief clarification only if the target page, intended change, destructive scope, or evidence conflict is unclear.

## Understand The Change

Translate the user's rough request into the concrete knowledge change needed. If the intent is reasonably clear, proceed without asking the user to restate it.

## Impact Query

Treat the user's requested change as a knowledge query, not only a file edit.

The referenced page is the primary edit target, but not necessarily the full edit scope.

Before writing, query the knowledge base for the changed claim or concept. Edit any page that would become stale, incomplete, or contradictory if left unchanged. Do not broaden the edit to loosely related pages.

## Apply Change
1. Generate draft ID: `edit-<slug>-<YYYY-MM-
DD>-<4-char-hex>`.
2. Create draft directory: `pending_review/
drafts/<draft-id>/knowledge/`.
3. Write only the files that need changes,
mirroring their `knowledge/` paths.
Use workspace-relative file paths only. Never use absolute server paths such as `/app/data/...`; write files as `pending_review/drafts/<draft-id>/knowledge/...`.
4. Update supporting files only when materially
needed:
    - `index.md` for new, renamed, removed, or
    moved pages
    - `overview.md` for changes to the overall
    business picture
    - `glossary.md` for company-, business-, or
    project-specific terminology changes
    - `log.md` for material knowledge changes
5. Write `pending_review/drafts/<draft-id>/
meta.json` with this structure:

    ```json
     {
       "id": "<draft-id>",
       "operation": "knowledge-edit",
       "description": "简短描述本次变更",
       "source_file": null,
       "affected_files": ["knowledge/path/Page.md"],
       "new_files": [],
       "modified_files": ["knowledge/path/Page.md"],
       "log_entry": "## [YYYY-MM-DD] knowledge-edit | Title"
     }
    ```

Existing pages go in modified_files; reserve
new_files for newly created pages.


Create one draft under `pending_review/drafts/` using the standard draft structure from `CLAUDE.md`.

Write only the files that need changes, mirroring their `knowledge/` paths.

Update supporting files only when materially needed:

- `index.md` for new, renamed, removed, or moved pages
- `overview.md` for changes to the overall business picture
- `glossary.md` for company-, business-, or project-specific terminology changes
- `log.md` for material knowledge changes

Write `meta.json`. Existing pages go in `modified_files`; reserve `new_files` for newly created pages.

## Reply

Reply briefly with what changed, which knowledge areas or page titles were updated, and that the user can confirm in the Review panel.

Do not expose `knowledge/`, `pending_review/`, `drafts/`, or other internal paths unless the user explicitly asks for implementation details.
