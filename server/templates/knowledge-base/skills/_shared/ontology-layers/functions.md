# Functions

Generates: `ontology/functions.yaml`

Functions are ontology-mounted business capability contracts. A Function is not the implementation code itself; it is the metadata that tells an agent or runtime what callable business capability exists, what ontology concepts it binds to, and what inputs and outputs it accepts.

Functions expose reusable read-only retrieval, calculation, decision, recommendation, or derived-logic capabilities over ontology objects, properties, and relations.

## When To Add

Add a Function when source material describes a reusable callable capability, such as:

- code-backed or API-backed computation over ontology data;
- retrieval or lookup behavior that should be exposed as a stable function contract;
- deterministic calculation, scoring, ranking, recommendation, or decision logic;
- prompt-backed business logic extracted from SOPs or policy text when no existing implementation exists.

Do not add a Function for:

- one-off answers that should not become reusable ontology behavior;
- implementation details that cannot be bound to ontology concepts;
- raw source table access, arbitrary joins, scripts, or repository operations;
- governed business submissions whose primary purpose is changing objects, properties, or relations. Put those in `actions.yaml`;
- permission, role, approval, or access-control rules. Put resource and action permissions on the owning Object Type, Relation Type, or Action Type.

## YAML Shape

```yaml
functions:
  - id: calculate_asset_depreciation
    name: CalculateAssetDepreciation
    type: CALCULATION
    intent: Calculate the current book value of an asset from its purchase price, usage years, and depreciation rules.

    ontology_bindings:
      primary_object: Asset

    inputs:
      asset_id:
        type: String
        required: true
        description: Target asset identifier.
      purchase_price:
        type: Number
        required: true
        description: Original asset purchase amount.
      usage_years:
        type: Number
        required: true
        description: Number of years the asset has been in use.

    outputs:
      type: Number
      description: Current residual asset value.

  - id: assess_asset_inspection_compliance
    name: AssessAssetInspectionCompliance
    type: DECISION
    intent: Decide whether an asset is high risk and recommend the next handling step based on age and repair history.

    ontology_bindings:
      primary_object: Asset
      related_objects:
        - InspectionRecord

    inputs:
      usage_years:
        type: Number
        required: true
        description: Number of years the asset has been in use.
      repair_count:
        type: Number
        required: true
        description: Historical repair count for the asset.

    outputs:
      type: Object
      properties:
        risk_level:
          type: Enum
          values: [HIGH_RISK, NORMAL]
          description: Risk assessment level.
        reason_code:
          type: Enum
          values: [EXCEEDED_AGE_LIMIT, EXCESSIVE_REPAIRS, COMPLIANT]
          description: Stable reason code for the assessment.
        recommendation:
          type: String
          description: Recommended next handling step.
```

This YAML shape is a recommended baseline. You may add fields required by the business scenario, but generally preserve the baseline fields and structure.

## Function Type

Each Function should define:

- `id`: stable `snake_case` function id;
- `name`: human-readable Function name;
- `type`: function category, usually `DECISION`, `CALCULATION`, `RETRIEVAL`, or `RECOMMENDATION`;
- `intent`: business purpose of the callable capability;
- `ontology_bindings`: primary and related ontology concepts the Function is about;
- `inputs`: typed parameters accepted by the Function;
- `outputs`: typed return value or return object schema.

## Rules

### Functions Extractor Rules

1. **Scope & Pure Computation**:
   - `functions.yaml` strictly defines **read-only, side-effect-free calculations, queries, or decision rules**.
   - **DO NOT** output permissions (`permissions`), safety guards (`safety_guard`), or side effects (`side_effects`). All mutation-related controls belong exclusively to `actions.yaml`.

2. **Function Types (`type`)**:
   - MUST be strictly limited to one of the following enumerations: `CALCULATION`, `DECISION`, `RETRIEVAL`, `RECOMMENDATION`.

3. **Ontology Bindings (`ontology_bindings`)**:
   - `primary_object`: Mandatory. Must reference the exact primary `object_type` in the Ontology that this function operates on.
   - `related_objects`: Optional list. Include ONLY when the function explicitly traverses or references associated objects.

4. **Input Parameters (`inputs`)**:
   - Name each parameter cleanly using standard casing (e.g., `usage_years`).
   - Define `type` strictly using valid scalar types (`String`, `Number`, `Boolean`, `Date`), or a specific Ontology Object Type name (e.g., `type: Asset`) when passing an object instance.
   - Set `required: true|false` based on whether the input is strictly needed.

5. **Output Schema (`outputs`)**:
   - For simple outputs, specify standard scalar `type` (`Number`, `String`, etc.).
   - For structured outputs, set `type: Object` and define explicit `properties`.
   - For list/collection outputs, explicitly set `is_array: true` (or `type: Array<Type>`) with `item_type` specified.
   - **DO NOT** output vague unstructured outputs like `type: Any`.

6. **No Execution Leakage**:
   - **DO NOT** attempt to guess or output backend code paths, module files, or script implementations. Limit all logic explanations exclusively to the concise `intent` field.
