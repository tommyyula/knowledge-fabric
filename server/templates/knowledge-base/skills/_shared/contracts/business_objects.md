# business_objects Contract

Use for core domain entities, records, and data models.

Required structure:
- Include `## Field Definitions` before `## Key Relationships`.
- List all entity fields in a table with: 字段名, 类型, 必填/选填, 说明.
- For important child objects, use `### {Child Object Name}` sub-tables.
- Place `> Source：{Source File Path}` above every field table, including child-object sub-tables.

Capture when supported:
- Business definition, scope, identity fields, and key fields.
- Lifecycle, statuses, enum values, validation rules, ownership, sensitivity, and risk fields.
- Relationships to other objects, tables, interfaces, and flows.
- Example identifiers or records if source-provided.
