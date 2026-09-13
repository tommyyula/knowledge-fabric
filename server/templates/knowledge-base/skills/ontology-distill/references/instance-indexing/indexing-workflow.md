# Instance Extraction Workflow

Use before creating or refreshing `ontology/object-instances.yaml`.

This workflow helps Claude turn the current object model and evidence in `knowledge/` into Object Instances and Link Instances. It is not a runtime indexer and does not design sync jobs, databases, publishing, or batch infrastructure.

## Inputs

- `ontology/object-model.yaml`
- `ontology/source-mappings.yaml`, when present
- `knowledge/`
- existing `ontology/object-instances.yaml`, when extending previous work

## Output

- `ontology/object-instances.yaml`, following `skills/_shared/ontology-layers/object-instances.md`

## Steps

1. **Load the model**
   - Read Object Types, properties, Relation Types, and `object_type_relations[]`.
   - Treat `object-model.yaml` as the only allowed structure.

2. **Find real entities**
   - Search `knowledge/` for concrete entities that match the current Object Types.
   - Do not create instances from examples, headings, type descriptions, or summaries.

3. **Create Object Instances**
   - For each real entity, create one `instances[]` item.
   - Use the Object Type primary key as `identity`.
   - Fill only properties defined on that Object Type.
   - Attach evidence and lineage.

4. **Create Link Instances**
   - Use `object_type_relations[]` to decide which Object Instances may connect.
   - Create a `link_instances[]` item only when the relationship is supported by evidence.
   - Do not create dangling or guessed links.

5. **Run Instance Gleaning**
   - After the first draft, call MCP tool `ontology_instance_gleaning` with `operation: next`.
   - Treat the returned `prompt` as mandatory continuation instructions.
   - Re-read the current scenario evidence and the generated `instances[]` / `link_instances[]`.
   - Add only missing items that match existing Object Types, properties, Relation Types, and `object_type_relations[]`.
   - Do not add duplicates, guessed links, new types, new properties, or new relations.
   - After each pass, call `ontology_instance_gleaning` again with `operation: next`; the backend computes added Object/Link Instance ids.
   - Continue until the tool returns `complete: true`. Do not call `complete_current` before this.

6. **Return To Main Workflow**
   - When `ontology_instance_gleaning` returns `complete: true`, stop this instance-indexing workflow.
   - Return to `SKILL.md` Step 5 for validator, `complete_current`, and scenario queue progress.

## Rules

- Do not define new Object Types, properties, Relation Types, or mappings here.
- Use `source-mappings.yaml` only as help for source fields and transforms; do not make it the main workflow.
- Use `UNKNOWN` for missing property values only when the Object Type allows it.
- If an instance or link cannot be supported by evidence, do not generate it; mention the gap instead.
