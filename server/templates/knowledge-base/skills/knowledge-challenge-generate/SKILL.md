---
name: knowledge-challenge-generate
description: "Generate challenge questions for knowledge validation. Use this skill whenever you need to populate the challenge queue. Triggered by 'generate challenge', '生成校验问题', or automatically called by $knowledge-challenge when the queue is empty."
---

# Knowledge Challenge Generate

扫描知识内容，生成校验问题，写入 `pending_review/challenge-queue.json`。

本 skill 只负责生成问题，不负责呈现和处理用户回答——那是 `$knowledge-challenge` 的职责。

## Entry Point

1. Read `pending_review/challenge-queue.json` if it exists.
2. Run `tools/build_graph.py --no-infer` to rebuild `graph/graph.json`. If Python/deps unavailable, build manually (same as `/knowledge-graph` workflow).
3. Determine scenario:
   - If the file does not exist OR the array is empty → go to [Scenario: First-time Generation](#scenario-first-time-generation首次生成)
   - If the array is non-empty → go to [Scenario: Incremental Generation](#scenario-incremental-generation增量生成)

---

## Scenario: First-time Generation（首次生成）

**When**: `challenge-queue.json` does not exist or is empty.

Read `knowledge/overview.md`, `knowledge/index.md`, `graph/graph.json`.

If the knowledge has fewer than 5 non-source pages, tell the user the knowledge is too small and suggest ingesting more content first. Stop here.

### Generate business questions (category: business)

**Tone rule (CRITICAL)**: Business questions are for product managers, market staff, and frontline business people. Write them as plain business stories:
- Use business language only — "用户下单"、"系统生成订单"、"管理员审批"
- Do NOT include: API paths (`/ecommerce/carts/...`), controller names (`OrderContextApi`), technical identifiers (`priceToken`, `cartId`), code-level concepts (`computed`, `EventHandler`), or system architecture terms (`BFF`, `DDD`, `限界上下文`)
- Embed business rules as natural consequences — "因为是企业级商品，系统要求填写公司信息" rather than "因为 requiresBusinessAccount 为 true"
- The reader should understand the story without any engineering background

**Landscape question (priority 0)**:

From `overview.md`, synthesize business storylines. Each should be a complete end-to-end business process, named in plain business language, with a one-sentence description.

Generate ONE `landscape` question entry with `question_type: "landscape"`, `category: "business"`. Write to queue immediately.

**Scenario walkthroughs (priority 1)**:

For each storyline:
1. Using `graph.json` clusters or `index.md` structure, identify which pages belong to this storyline (typically 1 flow page + connected capabilities, objects, rules, interfaces)
2. Precision-read ONLY these pages (typically 3-6 per storyline)
3. Construct a concrete scenario with:
   - A fictional but realistic actor (e.g., "客户张三", "采购员李四")
   - Specific dates, amounts, product names — make it tangible
   - Numbered steps walking through the entire flow from trigger to completion
   - Each step reflects what the knowledge actually says (not invented logic)
   - Key business rules embedded naturally into the narrative
4. If the knowledge has gaps, call them out: "知识中没有记录步骤 X 和步骤 Y 之间的具体处理逻辑"

Generate one `scenario` question per storyline. Store full scenario in `question_text`, all page paths in `related_pages`. Write to queue immediately.

**Edge-case probes (priority 1)**:

From rule pages, extract exceptions and edge cases. Generate `confirm` questions for each. Write to queue immediately.

### Generate technical questions (category: technical)

Read all `reports/*.md` files (if any). If no files exist, skip this section.

For technical quality findings:
- For **UNCERTAIN** items: generate a `confirm` question
- For findings marked **STALE**, **REMOVED**, or **deprecated**: generate a `still_active` question

Only generate questions for items with genuine ambiguity or potential knowledge inaccuracy. Do NOT generate questions for items that are simply not yet documented or SKIPPED items.

**Detail requirements (CRITICAL)**: Each technical question must contain enough context for an engineer to understand without re-reading the audit report:

1. Include concrete API paths / endpoint patterns (e.g. `/api/change-log/v1/*`)
2. Include source code file(s) that reference these endpoints (e.g. `common/global.ts`)
3. Include repo and module context (e.g. "agentcentral-web 前端调用 agentcentral-api 后端")
4. State what the audit found and why it's uncertain or conflicting
5. If the report's context is insufficient — read relevant source code in `raw/src/` to gather additional context (optional, only when needed)

Write all technical questions to queue immediately → go to [Finalize](#finalize).

---

## Scenario: Incremental Generation（增量生成）

**When**: `challenge-queue.json` is non-empty.

Preserve all existing entries. Read `knowledge/overview.md` and `knowledge/index.md` for full knowledge context.

### Build explored map

Read all entries in `challenge-queue.json`. Group resolved entries (`resolved_date` is not null) by status:

```
【已确认正确 (validated)】
- ch-XXX: <claim> → 用户确认
...

【已修正 (corrected)】
- ch-XXX: <claim> → 用户修正：<correction_summary>
...

【已跳过 (skipped)】
- ch-XXX: <claim> → 用户不确定
...

【已覆盖的知识页面】
（从所有条目的 knowledge_page + related_pages 去重列出）

【尚未被任何问题触及的知识页面】
（对比 knowledge/index.md 中的全部页面，找出从未出现在任何条目中的页面）
```

### Generate follow-up questions from four angles

Use the explored map as context. For each angle, read the relevant knowledge pages before generating questions. Business questions follow the tone rule from [Generate business questions](#generate-business-questions-category-business), technical questions follow the detail requirements from [Generate technical questions](#generate-technical-questions-category-technical).

**Angle 1 — 修正暴露的认知偏差 (priority 1)**

From `corrected` entries, extract the pattern of what knowledge got wrong. Read knowledge pages that share similar topics or were written from the same source, check if they might have the same type of error.

Example: if ch-004 was corrected because "知识把遗留审批流程当作活跃功能", scan other flow pages for similar legacy-as-active assumptions.

Set `source` to `d3:bias:<parent_id>`. If no `corrected` entries exist, skip this angle.

**Angle 2 — 已确认流程之间的缝隙 (priority 1)**

From `validated` entries, identify pairs of confirmed flows whose intersection was never questioned. Read the relevant pages to find handoff points.

Example: "订单流程" and "订阅续费" are both validated, but "续费失败后的退款处理" crosses both and was never asked.

Generate `scenario` or `confirm` questions. Set `source` to `d3:cross:<id1>+<id2>`. If fewer than 2 `validated` entries exist, skip this angle.

**Angle 3 — 未触及的知识页面 (priority 1)**

From the "尚未被任何问题触及的知识页面" list, read these pages and generate questions:
- For business_flows/business_capabilities pages → `scenario` or `confirm` questions (category: business)
- For interfaces/rules pages → `confirm` questions (category: technical)

Set `source` to `d3:gap`. If no untouched pages exist, skip this angle.

**Angle 4 — 跳过问题的重新提问 (priority 2)**

From `skipped` entries, rephrase using a different approach:
- If the original was `confirm` → rewrite as `scenario` with concrete examples
- If the original was `still_active` → narrow scope to a specific sub-feature
- Read the relevant knowledge page to find a more approachable angle

Set `source` to `d3:rephrase:<parent_id>`. Keep the same `category` as the original. If no `skipped` entries exist, skip this angle.

Write all generated questions to queue immediately after each angle → go to [Finalize](#finalize).

---

## Finalize

**Deduplicate and clean**

Read back the full queue. Remove any duplicate where `knowledge_page` + `claim` matches an existing entry with status `pending` or `validated` within the last 30 days. Write the cleaned queue.

**Archive old entries**: When `challenge-queue.json` exceeds 100 entries, move entries older than 60 days with status `validated` or `corrected` to `archived/past_questions.json`. If `past_questions.json` already exists, read it first and append the new entries to the existing array. Remove the archived entries from `challenge-queue.json`.

**Report**

Print a summary:
- 生成模式（首次 / 增量）
- 生成问题总数
- 各维度分布（首次: business: N, technical: N / 增量: 偏差: N, 缝隙: N, 未触及: N, 重提: N）
- 精读页面数量
- 当前队列中待处理问题总数

---

## Queue Entry Format

```json
{
  "id": "ch-YYYYMMDD-NNN",
  "knowledge_page": "knowledge/business_flows/OrderWorkflow.md",
  "related_pages": ["knowledge/rules/PaymentRule.md", "knowledge/business_objects/Order.md"],
  "claim": "具体断言或场景描述摘要",
  "question_type": "landscape | scenario | confirm | pick_one | still_active",
  "category": "business | technical",
  "question_text": "完整问题文本（scenario 类型包含完整场景叙述）",
  "priority": 0,
  "source": "d1:landscape | d1:scenario:storyline_name | d1:edge_case | d2:liveness:uncertain | d2:liveness:stale | d2:report:uncertain | d2:report:missing_overlap | d3:bias:parent_id | d3:cross:id1+id2 | d3:gap | d3:rephrase:parent_id",
  "status": "pending",
  "generated_date": "YYYY-MM-DD",
  "resolved_date": null,
  "correction_summary": null
}
```

`category` values:
- `business` — Written in plain business language for non-technical stakeholders.
- `technical` — May include technical details like API paths, controller names, code-level concepts.

## Decision Rules

- Never generate questions about source pages (`knowledge/sources/`).
- The `landscape` question should always be generated in first-time mode and always be priority 0.
- Scenario questions must faithfully reflect knowledge content — do not invent business logic that isn't documented.
- Minimize reads: if a page was already read, reuse its content. Track read pages to avoid duplicates.
- **JSON safety (CRITICAL)**: All `question_text` and `claim` values are written inside JSON strings. Do NOT use ASCII double quotes (`"`) for Chinese quotation marks inside these values — use Chinese fullwidth quotes (`""`) instead. For example, write `初始状态为\u201c试用中\u201d` not `初始状态为"试用中"`. ASCII `"` inside a JSON string value will break the JSON parser.
- **No internal IDs in question text**: `question_text` is shown directly to the user. Never include internal question IDs (e.g. `ch-20260422-004`) in the text. Use descriptive references instead (e.g. "之前关于用户注册的修正" instead of "ch-004 的修正").

## Language

Question text and scenario narratives are always in Chinese (matching knowledge content language). Frontmatter and structural elements remain in English.
