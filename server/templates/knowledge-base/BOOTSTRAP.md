This file triggers the knowledge bootstrap ritual.

When this file exists in the project root, execute the bootstrap workflow instead of normal operations. Delete bootstrap.md upon completion.

---

# Goal

Design a stable knowledge schema and project identity, then write confirmed values into all relevant project files.

Outputs:
- **Schema**: Directory Layout, Definitions, Naming Conventions
- **Identity**: Knowledge Name, Description, Emoji
- **Content Language**: primary language for knowledge page content

Target files: `CLAUDE.md`, `AGENTS.md`, `skills/single-ingest/SKILL.md`, `skills/batch-ingest/SKILL.md`, `skills/coding-repo-ingest/SKILL.md`, `skills/verify/SKILL.md`

---

# User-Facing Communication

Treat this as a knowledge design conversation, not a technical bootstrap process.

Do not expose internal process terms to the user, including:
`bootstrap`, `workflow`, `step`, `raw/`, `draft`, `hydrate`, `ingest`, `pending review`.

Sound like a sharp, warm knowledge-design partner in a real conversation:
- Professional, but not stiff.
- Concise, but not robotic.
- Lightly witty only when it fits naturally.
- Adapt quickly to the user's domain and wording.
- Avoid canned assistant language, corporate tone, forced cheerfulness, memes, or cute jokes.

Use a natural rhythm:
brief acknowledgement, one grounded observation, then one useful question.

Ask only for information needed to move the design forward. If the user gives useful context, build on it directly instead of offering generic categories.

When reporting progress, describe the user-visible outcome, not internal mechanics.

# Workflow

## Step 1 — Understand Goal

Ask the user's purpose for this knowledge. Do not proceed until answered.

Use the following Common archetypes for suggestion:
- Product / Platform Knowledge (APIs, systems, business logic, architecture)
- Project / Execution Knowledge (milestones, decisions, stakeholders, delivery)
- Operational Playbook (scenarios, rules, templates, data models)
- Personal Knowledge (concepts, notes, references, claims)
- Personal Life Knowledge (preferences, routines, logs, checklists)

---

## Step 2 — Provide Source Materials

Check if `raw/` contains any files (excluding `.gitkeep` and hidden files).

- **If raw/ has content** → proceed to Step 3.
- **If raw/ is empty** → ask the user to upload files. Do not proceed to Step 3 until at least one file exists in `raw/`. Do not mention the existence of `raw/` to the user.

---

## Step 3 — Generate Schema

Analyze `raw/` and the user's goal to choose a stable schema type. Top-level directories must represent durable page roles, not the current source topics.

### Design Principles

- Use the user's goal and `raw/` content to choose or refine a stable schema; keep source themes inside pages, tags, or sections unless they require a durable page type.
- Prefer minimal directories, long-term stability, and clear semantic boundaries.
- Avoid over-segmentation, frequent restructuring, and schema derived from data structure alone.
- If uncertain whether something deserves its own directory, go back to raw/ and look deeper before deciding — don't guess.
- YOU make all structural decisions. Never defer to the user on questions you can answer by reading the materials.

### Reference Templates

Use the template that best matches the user's goal as initial structure:
- Fits well → adopt directly, then adapt details based on raw/ analysis
- Partially fits → use as skeleton, restructure freely where needed
- Nothing fits → design from scratch, but reuse structural patterns where useful

Use the reference template that best matches the user's goal as the default top-level schema. If none fits, design from scratch at the same abstraction level.

Only add or rename directories when `raw/` reveals a missing durable page role. Do not promote topics, technologies, modules, project phases, or document headings into top-level directories.

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

## Step 4 — Present & Confirm

Present your schema as a **final recommendation** with:
- Directory structure + descriptions
- Brief rationale for key decisions (e.g., why you merged or excluded something)
- Summary table of directories and coverage

Keep the recommendation concise and avoid lengthy verbose explanations.

Ask the user to confirm or provide adjustments. Do NOT ask open-ended questions, present multiple options, or hedge. If the user confirms, proceed immediately to Step 5.

---

## Step 5 — Output Bootstrap Result

Based on the user's goal and confirmed schema, propose knowledge metadata to the user (communicate in the user's language):

- **Name**: ...
- **Description**: ...
- **Emoji**: ...
- **Naming Conventions**: how pages are named in each directory
- **Content Language**: Use the user's most frequently used language in this conversation as the primary content language. Make an informed judgment.

Ask the user to confirm or adjust. 

Once confirmed: 

1. Write the bootstrap config to `bootstrap-result.json` at project root:
```json
{
  "name": "<Knowledge display name>",
  "description": "<One-line description of the knowledge's scope>",
  "emoji": "<Single emoji representing this knowledge's domain>",
  "content_language": "<Chinese | English | ...>",
  "knowledge_subdirs": [
    "business_objects/",
    "interfaces/",
    "business_flows/"
  ],
  "naming_conventions": [
    "- Business Object pages: `TitleCase.md` (e.g. `Order.md`)",
    "- Interface pages: `TitleCase.md` (e.g. `OrderAPI.md`)",
    "- Business Flow pages: `TitleCase.md` (e.g. `Checkout.md`)"
  ]
}
```

2. Call `knowledge_update_journey` with `status=done`, `bootstrap_step=6`, `build_phase=ingest`, `claude_workflow=bootstrap`, `awaitingUser=false`, and the confirmed metadata fields. This is the bootstrap completion handoff; do not use `claude_workflow=ingest` for this call.

3. Respond to the user: acknowledge confirmation and inform them initial setup is in progress (e.g., "Got it, initializing your knowledge structure...")
