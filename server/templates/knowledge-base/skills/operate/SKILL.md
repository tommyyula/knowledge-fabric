---
name: operate
description: Use for executing concrete business tasks from knowledge evidence, ontology bindings, and available execution tools, such as checking order status, creating picking tasks, preparing approval decisions, triaging customer issues, generating exception lists, or coordinating follow-up actions. Use when the user wants action or operational results, not only explanation.
---

# Operate

Execute concrete business tasks by binding the user's intent to knowledge evidence, ontology bindings, and available execution tools.

Operate turns knowledge into action. Reading knowledge and ontology is a means to find an executable path, not the final output. The default execution bridge is Bash: use `bash` to call documented APIs, run scripts, inspect runtime data, transform returned JSON, and save useful operation artifacts. When a supported path can be reached through Bash, API, tool, function, or documented command, attempt it before reporting insufficiency.

Operate is an execution workflow, not a JourneyState phase. Do not call `knowledge_update_journey` only because an operation starts, progresses, succeeds, or fails.

```text
User operation request
  -> operation_start
  -> start and frame
  -> execution discovery
  -> try with Bash/API/tool
  -> fill missing execution details or fix errors
  -> run again
  -> operation_finish
  -> final answer
```

## Hard Invariants

1. **Execute first, explain after**: Do not turn an operation into a query-only answer. Use knowledge and ontology to find how to execute, then try the supported path.
2. **Do not invent execution results**: Report only what evidence, tool output, API response, command output, or verified artifact supports.
3. **Fix then run again**: If a tool call, API call, Bash command, query plan, or action submission fails or returns unusable output, make at most THREE evidence-backed corrections and run again after each correction.
4. **Maintenance boundary**: During Operate, only report `knowledge/` or `ontology/` gaps. Do not modify those files directly. Start a maintenance workflow only if the user explicitly asks after the operation.

## Operational Workflow

### Step 1: Start And Frame

1. Call `operation_start` before performing the task. Use the user's request as `user_request`; provide a short title when obvious.
2. Frame the request into an internal operation contract:
   - `Object`: target business object type, instance, lookup keys, or ids
   - `Property`: fields, statuses, values, timestamps, enums, metrics, filters, sorting, limits, or output fields
   - `Relation`: Relations, dependencies, membership, ownership, traversals, or existence checks
   - `Rule`: business rules, permissions, gates, calculations, allowed values, or allowed state changes
   - `Action`: executable operations, APIs, endpoints, Bash commands, tools, functions, side effects, or audit requirements

### Step 2: Execution Discovery

Inspect only enough knowledge and ontology to identify the executable path, required parameters, and source of truth.

#### Knowledge

- Read `knowledge/index.md` to identify seed pages.
- Read the most direct seed pages for the target object, action, scenario, rule, interface, source of truth, or expected output.
- Draft an internal operation understanding, not a user-visible answer:
  - what object, action, and result the user wants
  - what fields, rules, interfaces, and source-of-truth details seem relevant
  - what Bash command, tool, API, endpoint, function, script, or runbook step can execute the task
- If the executable path is still unclear, read additional directly relevant pages.
- Prefer, in this order:
  - pages explicitly Relationed from the initial pages or index entries for the same subject
  - pages that directly define the subject, behavior, constraints, data shape, state changes, or interaction contract
  - pages that explain adjacent dependencies, exceptions, lifecycle branches, permissions, source-of-truth boundaries, or API contracts
  - primary source evidence that anchors or resolves claims
  - high-level summaries only when they add cross-page framing
- Stop knowledge discovery as soon as a supported executable path is identified, or when targeted inspection confirms no executable path exists.

Do not enter the full Query workflow inside Operate. Do not emit `<working_answer>` or `<deepening_queries>`, do not ask to save a synthesis, and do not switch to a query-only final answer.

#### Ontology

Read only ontology artifacts relevant to the operation and verify bindings against them:

- `ontology/object-model.yaml`: Object Types, Properties, Relation Types, aliases, labels, allowed value terms, object type paths, edit modes, and permissions.
- `ontology/source-mappings.yaml`: source-of-truth mappings, field mappings, endpoint or tool references, ids, joins, transformations, and reachability expectations.
- `ontology/business-rules.yaml`: confirmed rules, gates, eligibility, status changes, and rule-backed conclusions when relevant.
- `ontology/functions.yaml`: reusable read, retrieval, calculation, decision, or recommendation contracts when relevant.
- `ontology/actions.yaml`: executable writes, submissions, permissions, side effects, audit behavior, and allowed state changes when relevant.
- `ontology/object-instances.yaml`: concrete Object/Relation Instances when the operation names or implies concrete business instances.

Verify that:
- user terms map through labels, aliases, allowed value terms, ids, and source terms
- Properties belong to the bound Object Type
- Relation Types exist and direction is correct
- Object Type paths are allowed by `object_type_relations`
- Functions or Actions exist before using them as executable capabilities
- Business Rules are confirmed before using them as hard rules
- source mappings support any claim that ontology reaches live source data

Prefer confirmed tool schemas and source-of-truth documentation over guessed endpoints, guessed fields, or remembered parameter shapes.

#### Execution Prep

Before the first attempt, identify:

- intended business outcome
- target object, id, or lookup key
- best available source of truth
- best available Bash/API/tool/function path
- expected useful output

Do not require complete ontology coverage, concrete object instances, exhaustive evidence, or perfect mappings before attempting execution.

Report blocked only after the try/fix/run-again loop stops, or after targeted inspection confirms no executable path, credential, endpoint, command, or required input exists.

External blockers include missing user input, unavailable connection, missing credential or permission, missing tool/Bash capability, inaccessible source data, or contradictory evidence requiring human decision.

Before saying `not found`, `not configured`, `not allowed`, or `does not exist`, check whether aliases, related objects, inverse relation directions, alternate sources of truth, incomplete live data coverage, stale ontology, or unread knowledge pages could explain the gap.

### Step 3: Try, Fix, And Retry

As soon as a supported executable path is found, attempt it. Use Bash as the default bridge when knowledge, ontology, source mappings, interface docs, or runbooks imply a command-line path.

During execution:
- use the exact Bash command, tool, API, endpoint, function, parameters, and source-of-truth mapping supported by evidence
- call `operation_log` with `summary` after major progress, tool success, tool failure, artifact creation, or blocker discovery
- write raw outputs, tables, JSON, diffs, logs, or intermediate outputs under `operations/<operation-id>/artifacts/` when they are useful for audit, debugging, or later inspection
- call `operation_log` with `type="artifact"` and the workspace-relative `path` when a user-visible artifact is created

If execution fails or the output is not enough to answer:
- if information is missing, re-check the relevant knowledge page, API page, command/tool schema, source mapping, ontology binding, or prior operation artifact
- if a tool, API, or Bash command errors, inspect the error and fix the command, parameters, endpoint, auth assumption, path, filter, or mapping using the error, returned data, or relevant documentation
- after each correction, run again

Stop only after three correction attempts, or when targeted inspection confirms the blocker cannot be fixed in the current run.

After execution, use the actual output to answer.

### Step 4: Finish And Report

If the operation should produce a durable human-readable report, pass `report_markdown` to `operation_finish`; it will be saved as `operations/<operation-id>/report.md`.

Finish every started operation with `operation_finish` using `status="succeeded"` or `status="failed"`.

When finishing, include these items in `operation_finish` fields when relevant:
- result summary
- precise failure blocker, if failed
- report markdown for durable operations, audits, or multi-step results
- artifact paths for raw outputs, tables, JSON, diffs, logs, or generated files

In the final user-facing answer, include:
- what you understood
- what you actually executed
- the result or blocker
- produced or changed files and artifacts
- material knowledge evidence or ontology bindings when they affect trust in the result
- semantic, ontology, execution access, or data coverage gaps when they are partial, missing, blocked, or material to the conclusion
- remaining user decisions, if any
