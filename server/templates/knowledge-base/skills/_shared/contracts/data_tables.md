# data_tables Contract

Use for business data tables, datasets, spreadsheets used as tables, or structured data sources.

Required structure:
- Include `## Table Purpose` before `## Field Definitions`.
- In `## Table Purpose`, state what the table is used for and what one row represents.
- Include `## Field Definitions`.
- List all table fields in a table with: Field, Type, Required/Optional, Description.
- For important child objects, use `### {Child Object Name}` sub-tables.
- Place `> Source：{Source File Path}` above every field table, including child-object sub-tables.

Capture when supported:
- Refresh, version, latest-snapshot, or report-date rule.
- Key identifiers and common lookup fields.
- Join relationships to other tables and scenario-dependent joins.
- Business term mapping: user language to actual field names.
- Enum/status values and their meanings.
- Query constraints: default filters, latest-date requirements, no-LIMIT rules, cast requirements, deduplication rules, or aggregation warnings.
- Sensitive fields, risk fields, unused/empty fields, and known caveats.
- Common usage examples or related scenarios.
