# Object Model

Generates: `ontology/object-model.yaml`

定义运营本体中的 Object Type、Relation Type 和 Object Type 之间的关系图。这里负责可复用的业务类型结构，包括对象属性、身份规则、属性取值约束、关系方向、基数和对象类型连接关系；不生成具体实例、样例行、日志或样本值。

`object-model.yaml` 是类型级约束的定义源。不要再单独生成约束文件。其他层可以引用 object model 中的类型和约束，但不能重新定义它们。

## 如何区别 Property 还是 Object

满足任一条件时，优先建 Object：

- 有独立业务身份或生命周期；
- 需要独立授权；
- 会连接多类对象；
- 需要记录自身来源、状态或历史；
- 业务会单独查询、讨论或操作它。

否则先作为 Object Type 内部的属性，避免把每个字段对象化。

## YAML Shape

```yaml
object_types:
  - name: Asset
    label: Asset
    aliases: [Equipment, Managed asset]
    definition: A managed business object with its own identity and lifecycle.
    semanticRefs:
      - business-concept:asset
    primaryKey: assetId
    labelTemplate: "Asset {assetId}"
    editMode: ALLOW_DIRECT_EDITS
    permissions:
      whoCanView:
        roles: [asset_inspector, maintenance_manager, admin]
        condition: "user.organizationId == object.organizationId"
      whoCanEditDirectly:
        roles: [admin]
    properties:
      - name: status
        label: Asset status
        aliases: [Lifecycle status]
        valueType: AssetStatus
        nullable: false
        allowedValues: [ACTIVE, INACTIVE]
        allowedValueTerms:
          ACTIVE:
            label: Active
            aliases: [In service]
          INACTIVE:
            label: Inactive
            aliases: [Retired, Disabled]
        source: asset-service.status
      - name: lastInspectedAt
        label: Last inspected time
        aliases: [Last inspection completed at]
        valueType: Instant
        nullable: true
        source: inspection-service.completedAt
    sourceRefs: true
    scope: organizationId
    accessPolicy: asset-read-policy

  - name: InspectionRecord
    label: Inspection record
    aliases: [Inspection report]
    definition: Evidence that an asset inspection was completed or attempted.
    primaryKey: inspectionId
    editMode: ONLY_VIA_ACTIONS
    permissions:
      whoCanView:
        roles: [asset_inspector, maintenance_manager, admin]
        condition: "user.organizationId == object.organizationId"
    properties:
      - name: completedAt
        label: Completed at
        aliases: [Inspection completion time]
        valueType: Instant
        nullable: true

relation_types:
  - name: HAS_INSPECTION_RECORD
    label: Has inspection record
    aliases: [Has inspection history]
    definition: Connects an asset to an inspection record that belongs to it.
    semanticRefs:
      - business-rule:asset-inspection-history
    from: Asset
    to: InspectionRecord
    reverseRelation: INSPECTION_RECORD_OF_ASSET
    cardinality: one-to-many
    missingTarget: ERROR
    duplicateTarget: ERROR
    editMode: ONLY_VIA_ACTIONS 
    permissions:
      whoCanView:
        roles: [asset_inspector, maintenance_manager, admin]

  - name: INSPECTION_RECORD_OF_ASSET
    label: Inspection record of asset
    aliases: [Belongs to asset]
    definition: Connects an inspection record back to the asset it documents.
    semanticRefs:
      - business-rule:asset-inspection-history
    from: InspectionRecord
    to: Asset
    reverseRelation: HAS_INSPECTION_RECORD
    cardinality: many-to-one
    missingTarget: ERROR
    duplicateTarget: ERROR
    editMode: ONLY_VIA_ACTIONS 
    permissions:
      whoCanView:
        roles: [asset_inspector, maintenance_manager, admin]

        
object_type_relations:
  - from: Asset
    relation: HAS_INSPECTION_RECORD
    to: InspectionRecord
    description: Find inspection records belonging to an asset.
    requiredFor: [asset_inspection_compliance]

  - from: InspectionRecord
    relation: INSPECTION_RECORD_OF_ASSET
    to: Asset
    description: Find the asset that an inspection record belongs to.
    requiredFor: [asset_inspection_compliance]
```
This YAML shape is a recommended baseline. You may add fields required by the business scenario, but generally preserve the baseline fields and structure.

Use `label`, `aliases`, and `definition` on the Object Type, Property, or Relation Type they describe. Keep enum/status/category values in `allowedValues`; add `allowedValueTerms` only when those values need business labels, aliases, or definitions.

## Object Type

Object Type 表示具有稳定业务身份、可独立查询和授权的运营对象，不是数据库行的别名。

### Rule for Object Type

每类 Object 至少定义：

- 业务语义引用；
- 稳定且唯一的主键；
- 属性类型、可空性、枚举、单位和 pattern；
- 源字段或派生规则；
- 数据范围和访问策略；
- 删除与身份变化规则。
- 编辑模式策略 `editMode`：
  - `ONLY_VIA_ACTIONS`（推荐）：强制必须通过预定义 Action 触发修改。用户只需具备 View 权限即可在 Action 逻辑与参数校验下提交修改，无需底层数据库写权限。
  - `ALLOW_DIRECT_EDITS`：允许绕过 Action 逻辑，通过 API、后台管理表格或数据库直写修改。要求用户必须具备底层数据集的直接写权限。
- `permissions.whoCanView.roles[]` 表示可查看该 Object Type 及其可见实例的业务角色或系统身份。
- `permissions.whoCanView.condition` 表示实例级条件过滤，支持 ABAC 动态表达式，例如按 `user.organizationId == object.organizationId` 做组织、部门或区域隔离。
- `permissions.whoCanEditDirectly` 仅在 `editMode: ALLOW_DIRECT_EDITS` 时生效，表示具体哪些角色或系统身份拥有底层数据集或 writeback dataset 的直接写权限。
- 权限提取必须证据驱动：只有当原始资料明确提到角色、组织隔离、部门隔离、区域隔离、审批人、管理员、系统账号、数据集写权限或特定可见/可编辑规则时，才填写 `permissions` 节点。
- 若原始资料未提及任何权限信息，`editMode` 默认设为 `ONLY_VIA_ACTIONS`，`permissions.whoCanView` 留空、设为 `[]` 或不填充，表示继承系统全局默认权限。
- 严禁自行发明原文中未提及的角色名称、系统身份或权限规则，例如不要默认加入 `admin`、`manager`、`operator`、`viewer` 等角色。

组合主键可以解决运行身份问题，但不能成为创造新业务名词的理由。

如果需要表达对象类型之间的父子层级，直接在 Object Type 上使用 `extends` 或 `subtypes`。不要单独新增抽象 axiom layer 来描述类型继承。

## Relation Type

Relation Type 表达两个 Object Type 之间可遍历的业务关系。

每个 Relation Type 都必须有一个方向相反的 Reverse Relation Type。正向和反向都要作为独立的 `relation_types[]` 条目建模，不能把反向名称塞进同一个 Relation Type 里当作显示别名。

例如，`Asset -HAS_INSPECTION_RECORD-> InspectionRecord` 和 `InspectionRecord -INSPECTION_RECORD_OF_ASSET-> Asset` 是两个独立的 Relation Type。它们方向相反、互相引用，但表达的是同一类业务连接在两个对象视角下的可导航关系。

这样做的目的，是让应用、算法和 AI Agent 无论从哪一端出发，都能沿着对象图进行业务可读的双向遍历。

### Rule for Relation

每条 Relation 至少定义：

- 起点、终点和对应的 `reverseRelation`；
- 基数；
- 业务含义；
- 支撑外键、关系数据集或确定性生成规则；
- 重复、悬空和删除处理。
- 编辑模式策略 `editMode`：
  - `ONLY_VIA_ACTIONS`（推荐）：关系建立、断开或改写必须通过预定义 Action 完成。
  - `ALLOW_DIRECT_EDITS`：允许通过 Action 以外的 API、后台管理表格或数据库直写改动关系。要求用户具备承载该 Relation Type 的底层数据集或 writeback dataset 的直接写权限。
- `permissions.whoCanView.roles[]` 表示可查看该 Relation Type 及其可见 Link Instance 的业务角色或系统身份。
- `permissions.whoCanView.condition` 表示 Link Instance 级条件过滤，支持 ABAC 动态表达式，例如按用户组织、部门、区域或两端对象属性隔离可见关系。
- `permissions.whoCanEditDirectly` 仅在 `editMode: ALLOW_DIRECT_EDITS` 时生效，表示具体哪些角色或系统身份拥有底层关系数据集或 writeback dataset 的直接写权限。
- 权限提取必须证据驱动：只有当原始资料明确提到角色、组织隔离、部门隔离、区域隔离、审批人、管理员、系统账号、关系数据集写权限或特定 Link Instance 可见/可编辑规则时，才填写 `permissions` 节点。
- 若原始资料未提及任何权限信息，`editMode` 默认设为 `ONLY_VIA_ACTIONS`，`permissions.whoCanView` 留空、设为 `[]` 或不填充，表示继承系统全局默认权限。
- 严禁自行发明原文中未提及的角色名称、系统身份或权限规则，例如不要默认加入 `admin`、`manager`、`operator`、`viewer` 等角色。

两个对象能 Join，不等于它们之间已经存在业务关系。

Relation Type 成对建模时必须满足：

- A -> B 的 Relation Type 和 B -> A 的 Reverse Relation Type 都必须显式存在于 `relation_types[]`；
- 两个 Relation Type 的 `from` 和 `to` 必须互为反向；
- 两个 Relation Type 的 `reverseRelation` 必须互相指向；
- 两个 Relation Type 是独立类型，名称应分别符合各自起点对象视角下的业务语言；
- 不要使用 `reverseName`、`inverseName` 或类似字段把反向关系混在单个 Relation Type 里。

## Object Type Relations

`object_type_relations[]` 是当前对象图的类型级连接清单。它不定义新 Relation，只声明哪些 Object Type 使用哪个已定义 Relation Type 连接。

每条 Object Type Relation 至少定义：

- `from`：已定义 Object Type；
- `relation`：已定义 Relation Type；
- `to`：已定义 Object Type；
- `description`：当前切片中为什么需要这条连接。

`object_type_relations[]` 用于指导和校验后续 Link Instance 抽取：Link Instance 的起点类型、关系类型和终点类型必须能匹配这里的关系图。由于 Relation Type 必须成对建模，`object_type_relations[]` 也应列出正向和反向两条类型级连接。
