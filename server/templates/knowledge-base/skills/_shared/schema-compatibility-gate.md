# Schema compatibility gate

在写入任何业务知识页面前，先判断新材料是否自然属于当前 schema。

只有同时满足以下条件，才允许继续 ingest：

- 内容属于现有 page type 的原本语义，不需要重新解释 page type
- 不会让知识库主题边界发生漂移
- 不会降低目录或页面分类精度
- 不是因为“没有更好的地方”才放入某个目录

如果需要牵强解释、弱化分类标准，或把内容硬塞进最接近的目录，先暂停写入业务知识页面，向用户说明 schema 不兼容。等用户确认 schema 处理方案后，再继续 ingest。

## Reject signals

出现以下情况时，倾向于判定为 schema 不兼容：

- 把业务集成文档归到 `concepts`
- 把业务规则或业务流程归到 `references`
- 把项目计划、里程碑、交付风险写进 `business_capabilities`
- 把数据字典、字段枚举、表关系塞进 `business_objects`，但 schema 没有 `data_tables` 或等价类型
- 把 API endpoint、request、response 细节写进 `business_flows`
- 把组织职责、审批权限、角色边界写进普通 `rules`
- 把外部系统对接、上下游依赖、消息队列、Webhook、批处理任务写进普通 `interfaces`
- 把用户研究、市场分析、竞品分析塞进产品或系统知识库
- 把临时故障日志、排查过程、事故复盘写进稳定业务能力页

## When rejected

先不要创建或修改业务知识页面。

向用户说明 schema 不兼容后，必须像新建知识库时一样重新分析本批材料适合什么 schema。
当前 schema 只能作为兼容性对照，不能作为默认起点。

- `原因`：材料的主要语义是什么，为什么不属于现有 schema
- `影响`：强行导入会污染哪些目录、页面类型或主题边界
- `方案`：必须按照下面的 `Schema recommendation method` 生成推荐：先推荐本批材料自身最适合的 schema，再说明如果用户坚持写入当前知识库，应如何扩展当前 schema；同时保留“另起一个知识库”的选项

## Schema recommendation method

## Generate Schema

Analyze the current source materials to choose a stable schema type. Top-level directories must represent durable page roles, not the current batch's topics.

### Design Principles

- Use source material to choose or refine a stable schema; keep source themes inside pages, tags, or sections unless they require a durable page type.
- Prefer minimal directories, long-term stability, and clear semantic boundaries.
- Avoid over-segmentation, frequent restructuring, and schema derived from data structure alone.
- If uncertain whether something deserves its own directory, go back to the source material and look deeper before deciding — don't guess.
- YOU make all structural decisions. Never defer to the user on questions you can answer by reading the materials.

### Reference Templates

Use the matching reference template as the default top-level schema.
Only add or rename directories when the source materials reveal a missing durable page role.
Do not promote topics, technologies, modules, project phases, or document headings into top-level directories.

#### Product / Platform / System Knowledge

> 材料主要描述系统"是什么"：API 接口定义、实体关系设计、架构图、模块职责划分。重点是系统的结构和能力，而非人在上面执行什么操作。

```
knowledge/
  business_capabilities/    # What the system can do (functional areas)
  business_flows/           # End-to-end workflows and processes
  business_objects/         # Core domain entities and data models
  interfaces/              # API interfaces, environment variables, MCP tools, webhooks, and external integration points
  rules/                    # Business rules and constraints
```

#### Project Management Knowledge

> 材料围绕交付过程展开：谁负责什么、什么时候交付、做了什么决策、有什么风险。重点是推进一件事从开始到结束的项目管理视角。

```
knowledge/
  milestones/     # Key delivery stages and progress checkpoints
  decisions/      # Architectural or product decisions (with rationale)
  stakeholders/   # People/teams involved and their responsibilities
  deliverables/   # Tangible outputs and artifacts
  risks/          # Identified risks and mitigation strategies
```

#### Personal Knowledge

> 材料是个人学习和思考的积累：读书笔记、概念定义、外部引用、个人结论。重点是构建和检索个人认知体系。

```
knowledge/
  concepts/       # Core ideas, definitions, mental models, and reusable distinctions
  notes/          # Learning notes, reading notes, and personal reflections not yet promoted into concepts or claims
  references/     # External sources, citation records, books, articles, links, and source context
  claims/         # Assertions, hypotheses, conclusions, or personal positions with supporting reasoning
  questions/      # Open questions, unresolved tensions, research threads, and ideas to investigate
```

#### Personal Life / Operations Knowledge

> 材料记录个人偏好、日常习惯、生活日志。重点是辅助个人决策和日常管理。

```
knowledge/
  preferences/    # User preferences and decision patterns
  routines/       # Repeated habits and workflows
  logs/           # Chronological activity records
  checklists/     # Action lists and operational checklists
```

#### Operational Playbook / Team Runbook / Process Execution Knowledge

> 材料以业务规则与执行场景为组织核心，关注"事情怎么干"——触发条件、判断逻辑、执行步骤与闭环机制。典型信号：材料涉及以 agentic 方式自动化业务流程中的判断与执行决策。

```
knowledge/
  data_tables/        # Business data tables: field definitions, types, constraints, required/optional flags, and table relationships
  scenarios/          # End-to-end execution scenarios: triggers, actors, steps, decision points, branches, exceptions, and closure criteria
  policies/           # Reusable decision policies: routing, escalation, approval, priority, SLA enforcement, thresholds, and exception handling
  business_semantics/ # Business semantics: concepts, metric definitions, default filters, aggregation logic, status meanings, and calculation rules
  templates/          # Reusable output templates: emails, notifications, reports, messages, and forms with field placeholders
```

---

## Present & Confirm

Present your schema as a **final recommendation** with:
- Directory structure + descriptions
- Brief rationale for key decisions (e.g., why you merged or excluded something)
- Summary table of directories and coverage

Keep the recommendation concise and avoid lengthy verbose explanations.

Ask the user to confirm the recommended schema handling plan or provide concrete adjustments. Do not ask broad open-ended questions. If presenting alternatives, clearly mark the recommended option.

## Maintenance ingest requirements

在维护导入场景中，不要写 `bootstrap-result.json`。

输出必须同时包含：

- 本批材料为什么不属于当前 schema
- 按上述方法论为本批材料推荐的 best-fit schema
- 如果写入当前知识库，需要对当前 schema 做什么扩展
- 如果不扩展而沿用旧 schema，会损失什么

硬性规则：

- 如果推荐“扩展当前 schema”，必须包含新增 page type，或对现有 page type 的明确语义重定义。
- 如果只是继续使用现有 page type，必须称为“沿用当前 schema”或“强行兼容导入”，不能称为“schema 扩展”。
- 用户确认 schema 处理方案前，不要继续 ingest。
- 用户只说“继续”、“继续啊”、“go ahead”或类似泛化继续语句时，不要视为已确认 schema 处理方案；必须要求用户明确选择扩展当前 schema、另起知识库，或沿用当前 schema 强行兼容导入。

## Completion / Handoff

Schema handling is confirmed when either:

- The current schema can be used as-is.
- The required schema change has been explicitly confirmed.

After schema handling is confirmed, immediately return to the calling ingest skill and continue the next step.
