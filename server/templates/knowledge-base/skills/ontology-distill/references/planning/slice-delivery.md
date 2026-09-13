# Slice Delivery Gate

Use only after all scenario cards are complete. Check only visible ontology artifacts. Do not claim runtime behavior that was not implemented or tested in this task.

## Maturity Gate

Check levels in order. Report the highest level whose required artifacts are present and coherent.

### L0 Semantic

Check:
- `object-model.yaml` captures labels, aliases, definitions, and allowed value terms when naming alignment is needed.
- `business-rules.yaml` captures confirmed/candidate rules with provenance when rules exist.
- `object-model.yaml` captures identity, value, relation, and type constraints when object/relation types exist.

Pass means the ontology can answer: "What is this?" and "What constrains it?"

### L1 Operational Objects

Check:
- `object-model.yaml` defines Object Types, Relation Types, and `object_type_relations[]` for required connections.
- `source-mappings.yaml` maps important fields and relations when source systems are known.
- `ontology/object-instances.yaml` exists for concrete entities required by the current scenario; without instances, do not claim L1.

Pass means the ontology can answer: "What exists now?" and "How are objects related?"

### L2 Decisions

Check:
- `functions.yaml` defines reusable Function contracts for retrieval, calculation, decision, recommendation, or implementation-backed capabilities.
- Functions declare allowed `conclusions` and `reason_codes`.

Pass means the visible artifacts define a deterministic decision contract.

### L3 Controlled Actions

Check:
- `actions.yaml` defines named business commands, not generic field updates.
- `actions.yaml` defines inline Action Type permissions such as `permissions.whoCanApply`, submission criteria, side effects, and audit requirements when source evidence supports them.
- `object-model.yaml` defines `editMode` and object/relation visibility or direct-edit permissions when source evidence supports them.

Pass means the ontology has a contract for safe business changes.

Do not claim Action execution, audit persistence, or projection refresh was verified unless this task provided implementation and test evidence.

## Final Response

Report:
- highest supported maturity level;
- artifacts created or updated;
- gaps blocking the next level;
- validation performed.
