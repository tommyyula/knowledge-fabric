---
name: ontology-distill
description: Distill ontology from knowledge. Use when the user asks to generate, refresh, extract, or improve ontology layers, reusable business semantics, digital-twin object models, agent task contracts, or ontology distilled from knowledge.
---

# Ontology Distill

## Goal
Build an operational ontology that is queryable explainable, and supports controlled actions.

An operational ontology is not a document index, nor is it a renamed database schema.Ontology serves as a digital twin of the organization, containing both the semantic elements (objects, properties, links) and kinetic elements (actions, functions, dynamic security) needed to enable use cases of all types.

## Deliverables

The generated ontology deliverables are placed in `ontology/`：

```text
ontology/artifacts/scenario-cards.json
ontology/object-model.yaml
ontology/source-mappings.yaml
ontology/actions.yaml
ontology/business-rules.yaml
ontology/functions.yaml
ontology/object-instances.yaml
```

## Ontology Modeling Stance

- **Operational domain first**：Use documents as evidence, but the modeled objects should be things in the business world: e.g. policies, rules, assets, customers, orders, events, approvals, obligations, exceptions, and so on.
- **Slice first, then expand**：Start with one operational scenario that can be validated. Do not try to cover the entire enterprise from the beginning.
- **Evidence-backed claims**：Any fact marked as confirmed must point to a source. If the evidence is weak, missing, or contradictory, do not mark the claim as `confirmed`. Treat inferred rules as `candidate` rules only, keep uncertain instance values as `UNKNOWN`, and list the remaining unresolved issues under `gaps` in the final response.
- **Operational instances**：When the source materials mention specific real-world objects or relationships, generate Object Instances and Link Instances. Do not stop at a type-only skeleton.
- **Store each fact once**：Any value with its own identity, lifecycle, properties, or reusable relationships should be modeled as an object or link, not duplicated as fields across multiple objects.

## 语言
- YAML 字段名、文件路径名保持稳定英文命名
- YAML 字段内容实用语言：`{{CONTENT_LANGUAGE}}`；若未水合或未知，读取根目录 `bootstrap-result.json` 的 `content_language`。
- 原文术语、法规名、系统字段和代码值保留原文

## Reference Index

### Layers

| 产物 | 何时读取 | Reference |
| --- | --- | --- |
| `ontology/object-model.yaml` | 定义 Object Type、对象属性、Relation Type、对象类型关系图、术语标签和类型级约束 | `skills/_shared/ontology-layers/object-model.md` |
| `ontology/source-mappings.yaml` | 记录本体字段/关系到真实数据源的映射 | `skills/_shared/ontology-layers/source-mappings.md` |
| `ontology/business-rules.yaml` | 定义确认/派生/候选业务规则 | `skills/_shared/ontology-layers/business-rules.md` |
| `ontology/actions.yaml` | 定义可提交的受控业务动作 | `skills/_shared/ontology-layers/actions.md` |
| `ontology/functions.yaml` | 定义可复用 Function 契约、输入输出和执行指针 | `skills/_shared/ontology-layers/functions.md` |
| `ontology/object-instances.yaml` | 定义有证据的 Object/Link Instance | `skills/_shared/ontology-layers/object-instances.md` |

## 禁止事项

- 不把文档、页面、章节或 source path 当成默认业务对象，除非领域本身就是文档管理。
- 不把数据库表直接命名为 Object Type。
- 不在 functions 或实例层中发明 object、relation、rule、action 或 permission。
- 不把空结果当作不存在；缺少覆盖证明时返回 `UNKNOWN`。
- 不把 candidate rule 当成 confirmed rule。
- 不为已知题目定制一次性对象图、Function 或查询接口。
- 不直接编辑 `ontology/artifacts/scenario-cards.json` 或 `scenario_cards[].status`；创建、调整和推进场景队列必须调用 MCP tool `ontology_update_scenario_cards`。
- 不直接编辑 `ontology/artifacts/instance-gleaning-state.json`；实例续抽轮次必须调用 MCP tool `ontology_instance_gleaning`，后端会按 scenarioId 记录历史。

## 本体构建流程

### Step 1. 选择场景切片

先探索 `knowledge/`，识别能支撑运营本体建模的真实决策场景。不要把资料结构、数据库表或文档目录直接当作场景；场景应来自业务问题、判断、证据和可能的后续动作。

你可以自行决定阅读顺序、抽样范围和是否扩大扫描。探索后应收敛为当前要构建的场景切片。

读取 `skills/ontology-distill/references/planning/scenario-cards.md`，然后调用 MCP tool `ontology_update_scenario_cards` 的 `set_queue` 操作写入候选场景队列。不要直接写 `ontology/artifacts/scenario-cards.json`。

### Step 2. 对齐建模方向

把候选场景卡里面的`决策问题`告知用户，确认本轮 ontology distill 的建模方向和处理顺序。用户可能没有本体建模经验，不要要求用户直接给 Object/Relation；用业务问题引导。

根据用户反馈调用 `ontology_update_scenario_cards` 的 `set_queue` 调整场景顺序和内容。Step 2 只负责确认并保存场景队列，不开始建模，不调用 `start_next`。

用户确认建模方向后，使用已保存的场景队列进入 Step 3。

### Step 3. 构建模型与契约

每轮只处理一个场景。先调用 `ontology_update_scenario_cards` 的 `start_next`，领取第一个未完成场景；然后复述工具返回的 `current.id`、`current.decision`、`current.target`、`current.conclusions` 和 `current.evidence`，把它作为本轮唯一建模目标。

只围绕该 `current` 场景构建或刷新类型、规则、映射和能力契约。不要因为资料中另一个对象更显眼就改变 target、decision 或 conclusions。场景是纵向建模切片，不是独立本体；所有场景共享并增量更新同一组 `ontology/` 产物。先读对应 reference，再写对应 YAML。不要在这一步生成实例。

推荐顺序：

1. 先读取 `skills/_shared/ontology-layers/object-model.md`，再生成或刷新 `object-model.yaml`：定义 Object Type、对象属性、Relation Type、Object Type 之间的关系图、术语标签、别名、身份、类型、枚举和基数约束。
2. 先读取 `skills/_shared/ontology-layers/source-mappings.md`，再生成或刷新 `source-mappings.yaml`：记录本体字段/关系与真实数据源字段、主外键、转换规则的对应关系。
3. 先读取 `skills/_shared/ontology-layers/business-rules.md`，再生成或刷新 `business-rules.yaml`：沉淀有证据的 if/then 业务规则。
4. 先读取 `skills/_shared/ontology-layers/functions.md`，再生成或刷新 `functions.yaml`：定义可复用只读 Function 契约、输入和输出；注意受控业务提交和本体对象/关系变更语义放在 `actions.yaml`。
5. 先读取 `skills/_shared/ontology-layers/actions.md`，再生成或刷新 `actions.yaml`：沉淀受控业务动作、Action Type 内嵌权限、提交门禁、side effects 和审计规则。


### Step 4. 增量生成 Object/Link Instance

当当前 `processing` 场景的资料中存在具体实体时，读取 `skills/_shared/ontology-layers/object-instances.md` 和 `references/instance-indexing/indexing-workflow.md`，根据 Step 3 已定义或更新的 Object Type、Relation Type 和 `source-mappings.yaml`，生成或刷新对应的 `ontology/object-instances.yaml`。

场景只是抽取和确认过程，不决定最终实例文件布局。所有Object Instance 和 Link Instance 都必须合并维护在`ontology/object-instances.yaml`中。

如果当前场景复用已有 Object Type 或 Relation Type，也只补充或刷新当前场景相关的实例和关系。不要等待所有场景完成后再统一提取实例；后续场景会继续增量扩展同一组实例文件。当前场景需要但模型中不存在的类型或关系，回到 Step 3 补模型，不要在实例层发明结构。

完成第一版实例文件后，必须调用 MCP tool `ontology_instance_gleaning` 的 `next`。把工具返回的 `prompt` 当作强制续抽指令执行；每完成一轮后再次调用 `next`，后端会自动计算新增 Object/Link Instance。直到工具返回 `complete: true` 前，不得进入 Step 5 或调用 `complete_current`。

### Step 5. 场景队列循环门禁

当 `ontology_instance_gleaning` 返回 `complete: true` 后，不要读取 `skills/ontology-distill/references/planning/slice-delivery.md`，也不要直接最终回复。先运行 `python3 tools/validate_ontology.py ontology --stage final` 校验当前完整 `ontology/` 产物；如果校验失败，修复所有报错并重新运行，直到退出码为 0。

validator 通过后，调用 `ontology_update_scenario_cards` 的 `complete_current`，传入当前场景 id。随后调用 `ontology_update_scenario_cards` 的 `status` 检查队列：

- 若 `allComplete=false`，继续调用 `start_next` 领取下一个场景，并回到 Step 3 处理该场景。不要在中途读取 `slice-delivery.md`，不要输出最终交付总结。
- 若 `allComplete=true`，说明所有场景都已经完成建模、实例补抽和 validator 校验，则`进入 Step 6。

### Step 6. 最终交付门禁

只有在 `ontology_update_scenario_cards status` 返回 `allComplete=true` 后，才读取 `skills/ontology-distill/references/planning/slice-delivery.md`。最终回复报告最高支持成熟度、已创建或更新产物、以及所有场景循环中执行过的 validator 校验结果。
