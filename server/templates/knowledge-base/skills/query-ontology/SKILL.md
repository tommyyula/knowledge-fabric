---
name: query-ontology
description: Query existing ontology artifacts only. Use only for read-only questions about `ontology/`, Object Types, Relation Types, Object/Link Instances, ontology Functions, inline ontology permissions, or ontology query coverage. Do not use for ordinary questions about `knowledge/` content; use query-deepen for that.
---

# Query Ontology

Use this for read-only answers from existing `ontology/` artifacts. Do not edit ontology files. Do not answer from `knowledge/` unless the user explicitly asks to compare ontology against knowledge.

Use `ontology-distill` for generating ontology artifacts. Use `edit-ontology` when updated knowledge may change ontology artifacts.

## Workflow

1. Read the ontology boundary before answering.
   - `ontology/object-model.yaml`: Object Types, properties, Relation Types, `object_type_relations`, labels, aliases, definitions, allowed value terms, `editMode`, and object/relation permissions when present.
   - `ontology/object-instances.yaml`: concrete Object Instances, property values, links, evidence, and lineage.
   - `ontology/functions.yaml` and `ontology/business-rules.yaml`: deterministic judgments and rule-backed conclusions.
   - `ontology/actions.yaml`: controlled actions, inline Action Type permissions, submission criteria, side effects, and audit rules when present.

2. Classify the question.
   - **Schema**: asks what object, property, or relation types exist.
   - **Instance**: asks which concrete objects or links exist.
   - **Path**: asks how objects are connected or whether traversal is possible.
   - **Rule/Function**: asks for a judgment, score, eligibility, reason, or calculation.
   - **Coverage**: asks whether the ontology can answer a question.

3. Build a bounded ontology query plan.
   - Map user terms through object model names, labels, aliases, allowed value terms, ids, and original source terms.
   - Start from known Object Types or Functions, then traverse only declared Relation Types.
   - Use `object_type_relations` to validate allowed type-to-type paths.
   - Use instance `links` and `inverse_relation` for concrete Object/Link traversal.
   - Prefer Functions and business rules for deterministic judgments; do not invent a Function when a bounded object query is enough.

5. Validate before answering.
   - Check that every referenced object, relation, property, function, rule, and instance exists.
   - Apply permissions or scope limits when defined.
   - Distinguish an empty result from missing or incomplete evidence.
   - If no real runtime exists, describe the plan as validated against YAML artifacts, not as an executed runtime query.

## Status

- `SUPPORTED`: the ontology directly supports the answer.
- `UNSUPPORTED`: the ontology schema has no matching business meaning.
- `NOT_OPERATIONALIZED`: the meaning exists, but required instances, functions, or runtime data are missing.
- `AMBIGUOUS`: multiple valid ontology bindings match the request.
- `UNKNOWN`: evidence is incomplete, stale, hidden by permissions, or not present in the artifacts.

## Reply

Include:

- direct answer
- status
- compact query plan
- evidence path using file and id references, such as `object-model.yaml:ObjectType.Asset`, `object-model.yaml:RelationType.HAS_RECORD`, `object-instances.yaml:asset_i001`, or `functions.yaml:calculate_eta`
- gaps or warnings

Do not expose SQL, Cypher, Mongo expressions, arbitrary joins, scripts, or raw source table structure.
