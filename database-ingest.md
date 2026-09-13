# Database Ingestion Workflow

## Purpose
将关系数据库中的原始表数据转换并映射到**本体（Ontology）**

---

### 第一阶段：数据采集与落盘（Ingestion）
* **增量/全量抽取**：连接数据库，采用全量快照或增量同步机制，将底层数据库的物理表拉取到 Knowledge Fabric 中。
* **生成 Raw Dataset**：拉取进来的物理表在 Knowledge Fabric 中被称为 **Dataset**（基础数据集，存储在分布式底层存储中）。

---

### 第二阶段：数据清洗与标准化（Transform & Pipeline）

原始数据库表通常存在字段缺失、命名不一致或脏数据，需要先进行 ETL：

* **数据清洗**：使用 Knowledge Fabric 的 Code Repositories（支持 PySpark, SQL 等）对 Raw Dataset 进行去重、空值处理、格式统一。
* **建表/合并**：将多张业务关联表进行连接（Join），整理出能够代表业务实体（如“客户”、“设备”、“订单”）的**精炼数据集（Curated Datasets）**。

### 第三阶段：物理元数据与数据画像提取规范（Machine Profiling Spec）
在 AI Agent 执行 Ontology Mapping 之前，数据平台底层需自动跑通以下 5 个模块的提取计算，并将结果打包为统一的 JSON/YAML 报告提交给 Agent。

## 1. 基础物理元数据（Physical Schema）
  * **表级元数据（Table Metadata）**：表名、表描述/注释、总行数。
  * **列级元数据（Column Metadata）**：列名、物理数据类型、是否允许为空、默认值。
  * **物理约束（Constraints）**：物理主键、物理外键关联。

---

## 2. 特征与统计分析（Column Profiling）
  * **唯一值比例（Cardinality Ratio）**：计算公式为 $\frac{\text{Distinct Count}}{\text{Total Rows}}$。若比例等于 `1.0` 且无重复值，自动标记为 `is_candidate_pk: true`。
  * **枚举候选项（Enum Profiling）**：针对低基数字段，提取完整 `distinct_values` 列表及其频次占比分布（如 `[1: 60%, 2: 30%, 3: 10%]`），标记 `is_enum_candidate: true`。
  * **数据模式识别（Pattern Profiling）**：提取字符串字段的正则特征（如自动识别 ISO-8601 日期、UUID、Email 或 IP 地址模式）。

---

## 3. 跨表/跨对象交集覆盖率（Cross-Table Overlap Analysis）
  * **值域重合度（Overlap Ratio）**：计算 `A表.column_x` 的值域集合在 `B表.column_y` 或 `现存Object.primaryKey` 中的落入比例。
  * **输出示例**：`orders.cust_id` → `Customer.customerId`（`overlap_ratio: 0.985`），供 Agent 作为隐式图关系推导的硬依据。

---

## 4. 安全脱敏数据采样（Sanitized Instance Samples）
* 预留但当前MVP阶段暂不实现，后续需要探讨具体实现方案。

---

## 5. 结构变更差异比对（Schema Migration Diff）
  * **变更标记（Change Badges）**：明确标记列状态为 `NEW_COLUMN`（新增）、`DELETED_COLUMN`（删除）或 `TYPE_CHANGED`（类型变更）。
  * **业务作用**：确保 Agent 优先执行“增量补丁更新（Patch/Extension）”，避免对已有 Ontology 进行不必要的全局重构。

---

### 第四阶段：本体更新

基于 ETL 清洗后的结果，以及 Machine Profiling Spec，Agent 执行本体更新：


#### TBD - 以什么处理逻辑与步骤来更新本体？待思考



1. 元数据提取与整理：读取给定的 DB Schema 和前 X 条采样数据，提取:
- 表名与表注释（Table Name & Comments）。
- 列名、数据类型、是否允许为空（Column Name, Data Type, Nullable）。
- 物理主键与外键约束（Primary Key & Foreign Key Constraints）。
2. 根据 Step 1 整理出来的内容，查询 Ontology 注册表，判断是否已存在匹配的对象，行程判断结论。
3. 根据 Step 2 的结论，执行更新 Ontology，更新的时候遵循以下顺序来检查是否有需要更新的
  3.1 读取 `skills/_shared/ontology-layers/object-model.md` 理解相关方法论，然后读取 `ontology/object-model.yaml` 了解现状，然后根据当前整理出来的内容进行相应的更新。
  3.2 读取 `skills/_shared/ontology-layers/source-mappings.md` 理解相关方法论，然后读取 `ontology/source-mappings.yaml` 了解现状，然后根据当前整理出来的内容进行相应的更新。
  3.3 读取 `skills/_shared/ontology-layers/business-rules.md` 理解相关方法论，然后读取 `ontology/business-rules.yaml` 了解现状，然后根据当前整理出来的内容进行相应的更新。
  3.4 读取 `skills/_shared/ontology-layers/functions.md`，然后读取 `functions.yaml`了解现状，然后根据当前整理出来的内容进行相应的更新。
  3.5 读取 `skills/_shared/ontology-layers/actions.md` 理解相关方法论，然后读取 `ontology/actions.yaml` 了解现状，然后根据当前整理出来的内容进行相应的更新。

---
