# Verify Skill

## Trigger Condition

Called only by an owning ingest workflow during its Verify Gate. Do not use this as a standalone user-facing workflow or top-level intent.

Invocation format used by the calling ingest skill:

```text
verify <source-path> <knowledge-path> [plan-path]
```

Arguments:

- `source-path`: directory containing source materials for generating QA pairs
- `knowledge-path`: directory containing knowledge pages to verify against
- `plan-path` (optional): path to an ingest plan JSON file (e.g. `ingest-plans/xxx.json`) for batch-based reading

---

## Execution Boundary

The main agent MUST execute Phase 1 and Phase 3 in the active workspace.

Do NOT delegate the whole Verify workflow to the Agent tool.

Only Phase 2 may use a sub-agent, and only to answer the questions-only file.

All Verify artifacts MUST be written under the active workspace `verify/<verify-run-id>/` directory.

All repairs MUST be written under the active workspace `knowledge-path`.

Never treat files written inside `.claude/worktrees/...` as final Verify artifacts.

---

## Architecture

Three phases, two agents — context isolation prevents the knowledge answerer from "knowing" the expected answers.

```
Main Agent (reads source-path):
  Phase 1: Generate QA dataset → save questions + expected answers
  Phase 3: Compare knowledge answers vs expected answers → evaluate → fix

Sub-Agent "knowledge-qa-batch" (isolated, never sees source-path):
  Phase 2: Read questions-only file → search knowledge-path → save knowledge answers
```

---

## Run Directory

Each Verify run owns one isolated directory under `verify/`.

- If `plan-path` is provided, read `plan_id` and `draft_id` from that plan and use `verify/<plan-id>/`.
- If no plan is provided and `knowledge-path` is a pending draft, use the draft directory name as the run ID.
- Otherwise generate a unique `<source-slug>-<YYYY-MM-DD>-<4-char-hex>` run ID.

Create the run directory before writing artifacts. Every artifact must include `plan_id` when available, `draft_id` when available, and `knowledge_path`. Never reuse another run's directory and never select artifacts by modification time alone.

---

## Steps

### Phase 1 — Generate QA Dataset (Main Agent)

**IMPORTANT**: Do NOT read any files under knowledge-path during this phase. QA pairs must be generated entirely from source-path content.

1. Read source files and generate question-answer pairs:

   **Reading strategy**:
   - **If plan-path is provided**: Read the plan JSON, then read source files batch by batch (following the plan's `batches` structure). Generate questions progressively as you read each batch.
   - **If no plan-path**: Scan all files under source-path, read in small groups, generate questions as you go rather than loading all files at once.
   
   If files are not directly readable (e.g. binary formats like xlsx, docx, msg), use Python scripts or appropriate tools to extract content first.

   **Question requirements**:
   - **Quantity**: 2-3 questions per batch (if using plan-path), or 2-3 questions per 3-5 files (if no plan-path). Ensure each of the 5 levels below has at least 1 question across the full set.
   - **Levels** (each at least 1 question):
     - **Fact Retrieval** — field values, definitions, enum options
     - **Relationship** — entity associations, dependencies, cross-references
     - **Process** — step sequences, trigger conditions, closure criteria
     - **Scenario Reasoning** — "given X condition, what happens?"
     - **Exceptions & Edge Cases** — boundary rules, special cases, fallback logic
   - Questions should cover different files — do not cluster on a single file
   - Questions must have a single correct answer derivable from the source. Avoid open-ended or opinion questions.

2. Save the full dataset to `verify/<verify-run-id>/dataset.json`:
   ```json
   {
     "source_path": "<source-path>",
     "plan_id": "<plan-id, when available>",
     "draft_id": "<draft-id, when available>",
     "knowledge_path": "<knowledge-path>",
     "date": "YYYY-MM-DD",
     "questions": [
       {
         "id": 1,
         "level": "fact | relationship | process | scenario | exception",
         "question": "...",
         "expected_answer": "...",
         "source_file": "..."
       }
     ]
   }
   ```

3. Extract questions-only file by running:
   ```bash
   python3 tools/extract_verify_questions.py verify/<verify-run-id>/dataset.json
   ```
   This produces `verify/<verify-run-id>/questions.json` (without `expected_answer` and `source_file`, with the run identity, `knowledge_path`, and `output_path` included). This is what the sub-agent receives.

---

### Phase 2 — Query Knowledge (Sub-Agent: knowledge-qa-batch)

Spawn the `knowledge-qa-batch` sub-agent with the questions-only file as input.

The questions-only file's `output_path` MUST point to the active workspace `verify/` directory. If it is relative or points inside `.claude/worktrees/...`, rewrite it before spawning the sub-agent.

- **Claude Code**: spawn the `knowledge-qa-batch` subagent defined in `.claude/agents/knowledge-qa-batch.md`
- **Codex**: spawn the `knowledge-qa-batch` custom agent defined in `.codex/agents/knowledge-qa-batch.toml`

The sub-agent will read the questions file, search knowledge-path for answers, and save results to the `output_path` specified in the questions file. 

The sub-agent must only:
- read the questions-only file
- search the provided knowledge-path
- write answers to the output_path

The sub-agent must NOT:
- generate the QA dataset
- compare expected_answer
- repair knowledge files
- write final results
- write meta.json
- update journey state
- call operation_start, operation_log, operation_finish, knowledge_update_journey, or any Operation Run tool
- write anything under operations/

Wait for the sub-agent to complete before proceeding.

The first knowledge-answers file is an immutable record of the initial knowledge answer. Do not overwrite it during repair or re-test.

---

### Phase 3 — Evaluate, Repair, Re-test (Main Agent)

1. Read the knowledge-answers file produced by the sub-agent.

2. Compare each `knowledge_answer` against its
`expected_answer`.

    Classify only as:

    - `pass` — the knowledge answer matches the expected
    answer and is supported by cited knowledge.
    - `fail` — the answer is missing, wrong, incomplete, ambiguous, contradictory, or not supported by cited
    knowledge.

    Do not mark `pass` only because the cited text contains
    the right information. The answer itself must be
    correct.

3. If every result is `pass`, skip to step 6.

4. For each `fail`, repair the knowledge under `knowledge-path`.
    - Go back to the source file from the QA dataset.
    - Find the missing or contradictory evidence.
    - Update only the relevant knowledge files under
    `knowledge-path`.
    - If the evidence exists but the sub-agent failed to
    find it, improve findability under `knowledge-path`:
    headings, nearby context, page title, index entry,
    overview link, or wording.

5. Re-test the failed questions.
   Create a questions-only file containing only the failed questions:
   ```
   verify/<verify-run-id>/failed-questions.json
   ```
  Set its output_path to:
  ```
  verify/<verify-run-id>/failed-knowledge-answers.json
  ```
  Do not rerun the full questions file for re-test. Do not write re-test answers to the original knowledge-answers file.
  
  Then:
    - Spawn `knowledge-qa-batch` again with the failed-questions file.

    - Read the failed-knowledge-answers file.

    - Replace the old `knowledge_answer` for those
    questions with the new answer.

    - Compare the new answer against `expected_answer`.

    Repeat steps 4-5 until every result is `pass` or a real
    blocker remains.

    A real blocker means the source evidence is missing,
    contradictory, unreadable, or cannot fit the current
    schema without user input.

    Sub-agent retrieval failure is not by itself a blocker.
    Treat it as a findability problem, repair the knowledge
    under `knowledge-path`, and re-test.

6. Save final results to `verify/<verify-run-id>/results.json` only after the latest post-repair answers have been compared.

   If a question failed initially and passed after repair, keep result: "pass" and explain the repair in note.
    ```json
    {
      "source_path": "<source-path>",
      "plan_id": "<plan-id, when available>",
      "draft_id": "<draft-id, when available>",
      "knowledge_path": "<knowledge-path>",
      "date": "YYYY-MM-DD",
      "summary": {"pass": 10, "fail": 0},
      "results": [
        {
          "id": 1,
          "question": "...",
          "expected_answer": "...",
          "knowledge_answer": "...",
          "knowledge_reference": {"file": "...", "cited_text": "..."},
          "result": "pass | fail",
          "note": "what was wrong or repaired if not initially pass"
        }
      ]
    }
    ```
7. Report to user:
   Verify 完成 — X pass / Y fail — Z issues fixed
  

---

## Question Generation Guidelines

Generate questions that test whether **specific knowledge** made it into the knowledge pages:

- Good: "MSD_WO 表中 order_status 字段的可选值有哪些？" (fact)
- Good: "ETA Report 与 Work Order 之间的关联关系是什么？" (relationship)
- Good: "Auto Flow Trigger 的第三步闭环条件是什么？" (process)
- Good: "当 region 既匹配 ETA Mapping 又命中 Special Case 时，哪个优先？" (exception)
- Bad: "概述一下订单管理系统" (too vague, any summary passes)
- Bad: "供应链系统好不好用？" (opinion, not factual)

---

## Language Rule

- Questions and answers should be in {{CONTENT_LANGUAGE}}
- Skill metadata and report structure in English
