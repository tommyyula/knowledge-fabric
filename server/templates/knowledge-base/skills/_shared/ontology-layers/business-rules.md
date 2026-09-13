# Business Rules

Generates: `ontology/business-rules.yaml`

Defines evidence-backed, reusable business rules.

A rule says: when these business facts are true, this conclusion, requirement, or restriction follows. Rules do not run functions, submit actions, define access permissions, or write data.

## Contract

- Defines: business rule ids and reusable condition/consequence logic.
- Depends on: object model and referenced actions/functions.
- Referenced by: actions and functions.
- Candidate rules are review material, not authoritative logic.

## YAML Shape

```yaml
business_rules:
  - id: active_asset_requires_current_inspection
    status: confirmed
    provenance:
      evidence:
        - source: knowledge/maintenance/policy.md
          locator: inspection_requirements
      confidence: high
    applies_to: [Asset]
    when:
      all:
        - fact: Asset.status
          operator: equals
          value: ACTIVE
    then:
      derive:
        fact: inspection_requirement_status
        value: REQUIRED
    used_by:
      functions: [assess_asset_inspection_compliance]
      actions: [schedule_asset_inspection]
```
This YAML shape is a recommended baseline. You may add fields required by the business scenario, but generally preserve the baseline fields and structure.

## Rules

- Add a rule only when the logic is reusable and supported by source evidence or explicit user confirmation.
- `status` must be `confirmed`, `derived`, or `candidate`.
- `confirmed` rules need direct evidence. `candidate` rules must not drive authoritative Function or Action behavior.
- `applies_to[]` must reference Object Types from `object-model.yaml`.
- `when.*[].fact` should reference known object properties, relations, or derived facts; use `allowedValues` from `object-model.yaml` for constrained `value` entries.
- `then.derive` creates derived facts; it does not create source facts or instances.
- `used_by.functions[]` must reference existing `functions[].id` in `functions.yaml`.
- `used_by.actions[]` must reference existing `actions[].id`.
- Put action execution details and Action Type permissions in `actions.yaml`; put Object Type and Relation Type visibility/edit rules in `object-model.yaml`; put function ids, outputs, and reason codes in `functions.yaml`.
