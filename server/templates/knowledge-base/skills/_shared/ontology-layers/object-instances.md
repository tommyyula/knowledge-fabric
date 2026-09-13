# Object And Link Instances

Generates: `ontology/object-instances.yaml`

把 `object-model.yaml` 里的 Object Type、Relation Type 和 Object Type 关系图落成具体事实。实例层只写 Object Instance、Link Instance、属性值、证据和血缘；不要在这里定义新的类型、属性或关系。

从源数据生成或刷新实例时，先执行 `references/instance-indexing/indexing-workflow.md`。

## Core

- Object Instance 是某个 Object Type 下的一条具体对象记录，例如 `Asset` 下的 `asset_a001`。对象实例可以独立存在，只要它有稳定身份、属性、证据和血缘。
- Link Instance / Link 是连接两个已存在 Object Instance 的一条具体关系线。它不能独立存在，必须依托一个 source Object Instance、一个 Relation Type 和一个 target Object Instance。
- Object Type、Relation Type、Property 和 Object Type 之间允许的关系定义都必须已经存在于 `object-model.yaml`。实例层只写具体对象、对象属性值、对象之间的具体连接、证据和血缘；不要在这里定义新的类型、属性或关系。
- 实例身份必须符合 `object-model.yaml` 中对应 Object Type 的身份规则。
- Object Instance 写在 `instances[]`。对象之间的具体关系写在 source Object Instance 的 `links[]` 下，不要作为独立顶层实体清单维护。

## Bidirectional Link Names

定义 Link Type 时，Schema 层必须同时给出正向关系名和反向关系名。单向关系定义是不完整的。

例如：

- 正向：`Flight -HAS_PASSENGER-> Passenger`
- 反向：`Passenger -PASSENGER_ON_FLIGHT-> Flight`

这样做的目的不是把同一条关系事实存两份，而是让应用、算法和 AI Agent 可以从任意一端进行双向图导航：既能从航班查乘客，也能从乘客查航班。

在实例层，一条 Link 通常只写一次，写在 source Object Instance 的 `links[]` 下，并同时记录 `relation` 和 `inverse_relation`。`inverse_relation` 表示同一条连接从 target Object Instance 反向读取时的业务名称，不表示第二条独立 Link。

如果 `object-model.yaml` 中只定义了正向关系、没有定义对应的反向关系名，应记录 review gap，不要生成方向不完整的 Link。

## YAML Shape

```yaml
instances:
  - id: asset_a001
    object_type: Asset
    identity:
      assetId: A-001
    properties:
      status:
        value: ACTIVE
        evidence: [{ source: asset-service.status }]
      lastInspectedAt:
        value: "2026-01-01T00:00:00Z"
        evidence: [{ source: inspection-service.completedAt }]
    evidence: [{ source: asset-service.asset }]
    lineage:
      sourceRefs:
        - { source: asset-service.asset }
        - { source: inspection-service.inspection }
      observedAt: "2026-01-01T00:00:00Z"
      indexedAt: "2026-01-01T00:05:00Z"
      syncRunId: sync_2026_01_01_0001
      scopeId: organization-001
    links:
      - relation: HAS_INSPECTION_RECORD
        inverse_relation: INSPECTION_RECORD_OF_ASSET
        to: inspection_record_i001
        evidence: [{ source: inspection-service.assetId }]
        lineage:
          sourceRefs: [{ source: inspection-service.inspection }]
          observedAt: "2026-01-01T00:00:00Z"
          indexedAt: "2026-01-01T00:05:00Z"
          syncRunId: sync_2026_01_01_0001
          scopeId: organization-001

  - id: inspection_record_i001
    object_type: InspectionRecord
    identity:
      inspectionId: I-001
    properties:
      completedAt:
        value: "2026-01-01T00:00:00Z"
        evidence: [{ source: inspection-service.completedAt }]
    evidence: [{ source: inspection-service.inspection }]
    lineage:
      sourceRefs: [{ source: inspection-service.inspection }]
      observedAt: "2026-01-01T00:00:00Z"
      indexedAt: "2026-01-01T00:05:00Z"
      syncRunId: sync_2026_01_01_0001
      scopeId: organization-001
```
This YAML shape is a recommended baseline. You may add fields required by the business scenario, but generally preserve the baseline fields and structure.


The single Link above supports both navigations:

- `asset_a001 -HAS_INSPECTION_RECORD-> inspection_record_i001`
- `inspection_record_i001 -INSPECTION_RECORD_OF_ASSET-> asset_a001`

Do not add a second Link under `inspection_record_i001` only to express the inverse navigation.

## Evidence and Lineage

`evidence` 说明事实依据；`lineage` 说明事实从哪里、何时、哪次同步、哪个范围进入实例层。多源合并时保留多个 `sourceRefs`。

## Rules

- 只为源材料中真实出现的业务实体创建实例；不要为类型、样例、总结或猜测创建实例。
- 不要默认一个源文档就是一个实例，除非业务对象本身就是文档。
- Instance `id` 必须稳定、snake_case，并在 `ontology/object-instances.yaml` 内全局唯一。
- 每条 Object Instance 都必须显式写 `object_type`，并引用 `object-model.yaml` 中已定义的 Object Type。
- `identity` 必须非空，并符合 `object-model.yaml` 的身份规则。
- `properties` 只能使用对应 Object Type 已定义的属性；每个属性值必须有 `value` 和 `evidence`。
- Object Instance 之间的关系必须写在 source Object Instance 的 `links[]` 下。不要创建顶层 `link_instances[]`，也不要把关系复制成普通属性字段。
- 每条 Link 的 source 是它所在的 Object Instance；`relation`、`inverse_relation` 和 `to` 必须匹配 `object_type_relations[]` 中允许的 Source Object Type + Relation Type + Target Object Type + Inverse Relation Type 组合。
- 每条 Link 都必须有 `inverse_relation`。反向关系名来自 `object-model.yaml`，不能由实例层临时发明。
- `to` 必须指向已生成的 Object Instance id；目标缺失、重复或不确定时记录 review gap，不要生成悬空 Link。
- Object Instance 和 Link 都必须有自己的 `evidence` 和 `lineage`。
- 如果一条“关系”本身有独立身份、生命周期、属性或可被复用，例如任职记录、审批记录、合同义务、派工单、检查记录，应把它建成 Object Instance，再用 Link 把它连接到相关对象。
- 多源合并要保留多个证据和多个 `lineage.sourceRefs`；证据冲突时创建 review gap，不要静默选择。
