# Source Mappings

Generates: `ontology/source-mappings.yaml`

记录业务本体属性与真实数据源字段、转换规则和缺失值处理之间的稳定对应关系。它是本体语义和企业权威数据源之间的受控桥梁。

当前层先只承接属性映射：一个 ontology property 来自哪个 source field，经过什么转换，是否允许为空。Link Type、Join 条件和实例关系生成先由 `object-model.yaml` 与实例抽取流程处理，不在这里混入第二套映射结构。

## YAML Shape

```yaml
mappings:
  - objectType: Asset
    ontologyProperty: lastInspectedAt
    valueType: Instant
    sourceField: inspection-service.inspections.completed_at
    transform: toUtcInstant
    nullable: true
    missingValue: UNKNOWN
```
This YAML shape is a recommended baseline. You may add fields required by the business scenario, but generally preserve the baseline fields and structure.

## Rules

- `source-mappings.yaml` only records property-level mappings from physical source fields to ontology properties.
- Do not declare joins, Link Type generation, generated Link Instances, primary/foreign keys, write-back rules, or API mutation code in `source-mappings.yaml`.
- `mappings[].objectType` must match an exact Object Type name from `object-model.yaml`.
- `mappings[].ontologyProperty` must match an exact property name on that Object Type.
- `mappings[].valueType` must strictly match the property's declared type in `object-model.yaml`, such as `String`, `Number`, `Boolean`, `Instant`, or `Date`.
- `mappings[].sourceField` must use the standard path format `<datasource_or_service>.<table_or_endpoint>.<field_name>`, such as `mysql_asset.asset_records.purchase_date`.
- If a source field maps directly without modification, set `transform: IDENTITY`.
- `mappings[].transform` should use a controlled vocabulary where applicable, such as `IDENTITY`, `toUtcInstant`, `toString`, `parseJson`, or `divideBy100`. Do not use descriptive prose as transform names.
- Record null/default handling, conflict policy, and tombstone rule when relevant.
- Missing, incomplete, or corrupted source values must map to `missingValue: UNKNOWN` or `missingValue: NULL`.
- Never turn missing source values into speculative defaults unless explicitly mandated by business logic outside this layer.
- Action/write behavior must still go through `actions.yaml` and the edit/permission semantics defined on Object Types, Relation Types, and Action Types; mappings only locate authoritative sources.
