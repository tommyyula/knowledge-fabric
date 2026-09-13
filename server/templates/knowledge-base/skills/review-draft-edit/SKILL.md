---
name: review-draft-edit
description: Revise the active pending Review draft in place without creating a new draft.
---

# Review Draft Edit

Use this when the user asks to revise content that is already staged in the Review panel.

This skill only edits existing draft files in place.

## Rules

- If the user provides `@` document paths, treat them as the primary edit anchors.
- Also check whether other existing draft files need small synchronized changes to keep the pending draft internally consistent.
- If the user does not provide `@` document paths, infer the likely target files from the conversation context and existing draft content.
- Do not create a new draft.
- Do not edit sibling drafts.
- Do not edit root `knowledge/`.
- Do not edit `raw/`.
- Do not update `meta.json`.
- Do not call the normal `knowledge-edit` skill.
- Do not run Verify only because of this Review-stage revision.
- Use workspace-relative file paths only. Never use absolute server paths such as `/app/data/...`.
- If the target files or intended change are still unclear after checking context, ask one brief clarification.

## Steps

1. Identify the existing draft file or files that should change.
2. Read those draft files.
3. Apply the user's requested change with the smallest necessary edit.
4. Re-read the changed area to confirm the edit.
5. Reply briefly with what changed.

## Reply

Reply briefly with what changed.

Do not expose internal paths unless the user explicitly asks for implementation details.
