---
name: edit-ontology
description: Update existing ontology artifacts only. Use only when the user explicitly asks to update `ontology/`, or when approved/updated knowledge must be reflected in existing `ontology/` files such as object models, mappings, rules, actions, functions, or instances. 
---

# Edit Ontology

Use this when the input is updated knowledge and the current `ontology/` may need to change.

Updated knowledge means knowledge that has been accepted as the new source of truth. It may come from approved Review drafts later; until that workflow exists, treat it as `updated knowledge`.

## Hard Handoff Gate

Before deciding targeted edits, inspect `ontology/`.

If `ontology/` is missing or empty, stop using `edit-ontology` and immediately read and follow `skills/ontology-distill/SKILL.md` in the same run.

Do not reply to the user with "ontology-distill should be used", "there is no ontology to update", or "please provide an ontology path" unless the user explicitly claimed an existing ontology lives elsewhere. Absence of a usable `ontology/` baseline means the task is initial ontology distillation from the updated knowledge, not a blocked edit.

## Workflow

1. Read the updated knowledge first.
2. Inspect the current `ontology/` files that could be affected.
3. Decide the impact:
   - no ontology change needed
   - update existing ontology entries
   - stay in `edit-ontology` for targeted updates to existing ontology objects, properties, relations, rules, mappings, actions, functions, or instances
   - use `skills/ontology-distill/SKILL.md` instead when `ontology/` is missing, has no real artifacts, or the update changes the modeling scope enough that you must first choose/revisit the operational scenario, object boundaries, or rule/action surface
4. Before editing a layer, read the matching reference in `skills/_shared/ontology-layers/` when needed.
5. Edit only the affected `ontology/` files.
   - For existing ontology files, use `Edit` or `MultiEdit` for targeted changes. Do not use `Write` or `Bash` to rewrite whole files.
6. Run `python3 tools/validate_ontology.py ontology --stage final`. If validation fails, fix all errors and rerun the validation until the exit code is 0.

## Impact Guide

- Object, property, or relation meaning changed: update `ontology/object-model.yaml`.
- New or changed aliases, labels, or domain terms: update the relevant Object Type, Property, Relation Type, or `allowedValueTerms` in `ontology/object-model.yaml`.
- Source field meaning changed: update `ontology/source-mappings.yaml`.
- Business rule changed: update `ontology/business-rules.yaml`.
- Controlled write intent changed: update `ontology/actions.yaml`.
- Object or relation access/edit rule changed: update `ontology/object-model.yaml`.
- Action apply/edit permission changed: update `ontology/actions.yaml`.
- Reusable calculation or query contract changed: update `ontology/functions.yaml`.
- Specific real-world object or link changed: update `ontology/object-instances.yaml`.

## Reply

Reply briefly with:

- what updated knowledge was considered
- which ontology files changed, or why no change was needed
- any gaps or uncertain impacts
