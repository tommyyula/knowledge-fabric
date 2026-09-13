---
name: knowledge-challenge
description: "Proactively validate knowledge claims through targeted confirmatory questions. Use this skill whenever the user says 'challenge', 'knowledge challenge', 'validate knowledge', 'spot check', '校验知识', '挑战模式', '验证知识', '做题,' '检查知识准确性', or any similar request about proactively checking knowledge accuracy."
---

# Knowledge Challenge

从 `pending_review/challenge-queue.json` 中逐条呈现校验问题，处理用户回答，更新知识。

本 skill 只负责呈现和处理，问题生成由 `$knowledge-challenge-generate` 负责。

## Interaction Rule (CRITICAL)

All questions MUST be presented as plain chat text output — do NOT use the `AskUserQuestion` tool. The reason: `AskUserQuestion` renders in a steps panel where the user cannot reply; the LLM ends up answering its own questions.

The correct interaction pattern:
1. Output the question as normal markdown text in the chat
2. **STOP your turn immediately** — do not continue processing, do not answer your own question, do not skip ahead
3. Wait for the user to reply in the next message
4. In the next turn, read the user's reply and process it (update knowledge, update queue JSON, etc.)

Each turn should present exactly ONE question (or one scenario) and then stop. Never batch multiple questions into a single turn. Never assume the user's answer.

## Turn Resumption Protocol

Because each question spans multiple conversation turns, the LLM must recover state reliably at the start of every turn.

At the start of each turn (after the user replies):
1. Read `pending_review/challenge-queue.json`
2. Find the first entry with `"status": "in_progress"` — this is the question the user just answered. Its `category` field tells you which category the user chose. → Go to Step 3 to process the answer.
3. If no `in_progress` entry exists, check the **current conversation history** for whether the user has already answered the category preference question (Step 1.5) in THIS session. Only count an explicit user reply of "业务" or "技术" (or equivalent) in the conversation as a valid category choice.
   - If the user HAS chosen a category in this conversation → use that category, go to Step 2.
   - If the user has NOT chosen a category in this conversation → go to Step 1 → Step 1.5 to ask.

**CRITICAL**: Never infer the user's category choice from queue data (e.g. resolved/validated/skipped entries). Those entries may come from previous sessions. The category preference MUST come from an explicit user reply in the current conversation.

When presenting a question (Step 2), update its status to `"in_progress"` before outputting the question text. This marks which question is currently being discussed.

Status lifecycle: `pending` → `in_progress` → `validated` | `corrected` | `skipped`

## Workflow

### Step 1: Load the challenge queue

Read `pending_review/challenge-queue.json`.

- If the file doesn't exist or has no items with `"status": "pending"`: run `$knowledge-challenge-generate` first (read and follow `skills/knowledge-challenge-generate/SKILL.md`), then re-read the queue.
- If pending questions exist: proceed to Step 1.5.

### Step 1.5: Ask user for category preference

Count pending questions by `category` field (`business` vs `technical`). Present the choice as plain chat text, then STOP:

```
当前待校验的问题：
- 业务方向（business）：N 个 — 业务流程、场景走查、业务规则确认
- 技术方向（technical）：M 个 — 接口活跃性、审计发现、技术细节确认

你想先回答哪个方向的问题？回复"业务"或"技术"即可。
```

**STOP. Wait for user reply.**

After the user replies, filter the queue to only show questions matching the chosen `category`. Proceed to Step 2 with the filtered set.

### Step 2: Present questions to the user

Read `pending_review/challenge-queue.json`, filter to `"status": "pending"` AND the user's chosen `category`, sort by `priority` (lowest first, i.e. priority 0 before priority 3).

If no pending questions remain in the chosen category, check the other category:
- Present the user with a choice:
  ```
  当前方向的问题已经做完了。你可以：
  1. 切换到另一个方向（还有 N 个 技术/业务 方向的问题）
  2. 继续当前方向，生成新的 业务/技术 问题

  回复"切换"或"继续"即可。
  ```
  (If the other category has 0 pending questions, only show option 2.)
  **STOP. Wait for user reply.**
  - If user chooses to switch → update the active category, go to Step 2 with the other category.
  - If user chooses to continue → run `$knowledge-challenge-generate` (read and follow `skills/knowledge-challenge-generate/SKILL.md`), then re-read the queue and go to Step 2 with the same category.
- If no pending questions remain at all: offer to generate a fresh batch. "所有方向的问题都做完了。要生成新一轮问题吗？" **STOP. Wait for user reply.** If yes → run `$knowledge-challenge-generate`, then go to Step 1.5.

Present ONE question per turn as plain chat text, then STOP.

**For `landscape` questions** (priority 0):

```
我根据知识的内容，整理了目前覆盖的几条核心业务主线：

1. **客户订单流程** — 从客户下单到确认收货的完整购买链路
2. **采购入库流程** — 从供应商采购到商品入库上架
3. **库存管理** — 库存盘点、调拨、预警
...

请先从整体上看一下：这些是不是基本覆盖了你们的核心业务？有没有遗漏的重要流程？或者有些其实不算核心？
```

**STOP. Wait for user reply.**

**For `scenario` questions** (priority 1):

```
我用一个具体案例来走一遍「客户订单流程」，你帮我看看有没有不对的地方。

假设客户张三在 2月2日 10:30 下单购买 iPhone 15（订单号 ORD-001）：

1. 张三在网站上提交订单，系统生成订单号 ORD-001
2. 张三选择支付方式，完成付款（5999元）
3. ...

这个流程对吗？如果有不对的地方，请直接告诉我哪一步需要修改。
```

**STOP. Wait for user reply.**

**For `confirm` questions** (any priority):

```
知识页面: [[PageName]]
知识记录: "<具体断言>"

这是否仍然正确？如果有变化请直接说明。
```

**STOP. Wait for user reply.**

**For `pick_one` questions**:

```
涉及页面: [[PageA]] vs [[PageB]]
PageA 说: "<断言A>"
PageB 说: "<断言B>"

哪个是正确的？还是两个都不对？
```

**STOP. Wait for user reply.**

**For `still_active` questions**:

```
知识页面: [[PageName]]
知识记录该能力为活跃状态，但审计未能确认。

这个能力目前是否仍在使用？如果已迁移请说明迁移到了哪里。
```

**STOP. Wait for user reply.**

### Step 3: Process user response

Read the user's reply and determine the outcome:

**User confirms (correct / 没问题 / 是 / 流程正确)**:
1. Update the question's `status` to `"validated"`, set `resolved_date`
2. Write updated queue to `pending_review/challenge-queue.json`
3. Present the next pending question (back to Step 2)

**User says wrong and provides correction**:
1. Clarify if needed (then STOP and wait after each clarification):
   - **User only says "不对" / "有问题" without details**: ask which specific part is wrong. For `scenario` questions, reference the step numbers: "能告诉我具体是哪一步有问题吗？比如步骤几？" **STOP. Wait for user reply.**
   - **User says which part is wrong but not what the correct version is**: ask for the correct version: "明白了，步骤 4 不对。那正确的流程应该是怎样的？" **STOP. Wait for user reply.**
   - **User provides both the error and the correction**: proceed directly to step 2.
2. Read the affected knowledge page(s) listed in `knowledge_page` and `related_pages`
3. Trace the correction to the specific knowledge page(s) that contain the wrong claim
4. Show the user which pages will be affected:
   ```
   根据你的修正，以下知识页面需要更新：
   - [[OrderWorkflow]] — 步骤 4 需要修改为...
   - [[WarehouseDispatch]] — 分配逻辑需要修改为...
   确认修改吗？还是需要再调整？
   ```
   **STOP. Wait for user reply.**
5. After user confirms, apply corrections following the Language Rule (English frontmatter/headings, Chinese content)
6. Update `last_updated` in frontmatter for all affected pages
7. If the correction affects claims referenced by other pages (check `[[links]]`), update those too
8. Update `knowledge/overview.md` if the correction changes the overall business picture
9. Update the question's `status` to `"corrected"`, set `resolved_date` and `correction_summary`
10. Write updated queue to `pending_review/challenge-queue.json`
11. For `scenario` questions: re-generate the corrected scenario and present it for final confirmation before moving on
12. Present the next pending question (back to Step 2)

**User skips (跳过 / 不确定 / 下一个)**:
1. Update `status` to `"skipped"`
2. Write updated queue to `pending_review/challenge-queue.json`
3. Present the next pending question (back to Step 2)

**User wants to stop (结束 / 够了 / done)**:
Go to Step 4.

### Step 4: Log and report

After the session ends:

1. Append to `knowledge/log.md`:
   ```
   ## [YYYY-MM-DD] challenge | 知识校验会话
   校验 N 个问题：M 个确认正确，K 个已修正，J 个跳过，L 个待处理。
   修正页面：PageA、PageB、...
   ```

2. Write final queue state to `pending_review/challenge-queue.json`

3. Print session summary.

### Step 5: Regenerate if queue exhausted

This step is now handled inline in Step 2 — when the chosen category is exhausted, the user is offered to switch or generate new questions. This section is kept for reference only.

## Challenge Queue Format

`pending_review/challenge-queue.json` is a JSON array:

```json
[
  {
    "id": "ch-YYYYMMDD-NNN",
    "knowledge_page": "knowledge/business_flows/OrderWorkflow.md",
    "related_pages": ["knowledge/rules/PaymentRule.md", "knowledge/business_objects/Order.md"],
    "claim": "具体断言或场景描述摘要",
    "question_type": "landscape | scenario | confirm | pick_one | still_active",
    "category": "business | technical",
    "question_text": "完整问题文本（scenario 类型包含完整场景叙述）",
    "priority": 0,
    "source": "d1:landscape | d1:scenario:storyline_name | d1:edge_case | d2:liveness:uncertain | d2:liveness:stale | d2:report:finding_type | d3:spot_check",
    "status": "pending",
    "generated_date": "YYYY-MM-DD",
    "resolved_date": null,
    "correction_summary": null
  }
]
```

Status values: `pending`, `in_progress`, `validated`, `corrected`, `skipped`.

## Decision Rules

- If the queue is empty, always call `$knowledge-challenge-generate` first — never generate questions directly in this skill.
- When a correction cascades to multiple pages, list all affected pages before applying and ask the user to confirm.
- After correcting a scenario, always re-present the corrected version for final confirmation before moving on.

## Language

Respond in the same language the user used. Question text and scenario narratives are always in Chinese (matching knowledge content language). Frontmatter and structural elements remain in English.
