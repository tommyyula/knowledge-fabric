# Scenario Cards

Generates: `ontology/artifacts/scenario-cards.json`

Stores candidate modeling scenarios and the queue order for slice-by-slice ontology building.

Use MCP tool `ontology_update_scenario_cards` to create, adjust, start, complete, or inspect the queue. Do not edit this JSON file directly.

## Shape

```json
{
  "scenario_cards": [
    {
      "id": "stable_snake_case_id",
      "status": "pending",
      "name": "场景名称",
      "actor": "谁提出问题或执行决策",
      "decision": "要做出的业务判断",
      "target": "判断的业务对象",
      "conclusions": ["允许的结论枚举"],
      "evidence": ["每个结论所需的对象和关系证据"],
      "dataScope": "时间、组织、租户或业务范围",
      "freshness": "可接受的数据延迟",
      "candidateAction": "判断后可能执行的业务动作"
    }
  ]
}
```

## Rules

- `scenario_cards[]` order is the processing queue.
- Status values are only `pending`, `processing`, and `success`.
- Use `set_queue` to create or adjust scenario order/content; unfinished cards are normalized to `pending`.
- Use `start_next` before modeling; it marks the first unfinished scenario as `processing` and returns it as `current`.
- Process only the returned `current` scenario.
- Use `complete_current` only after the current scenario has completed modeling, instance gleaning, and validator checks; pass the current scenario id.
- Use `status` to inspect progress before continuing. If `allComplete=false`, continue with `start_next`; do not run the final slice delivery gate yet.
- At most one scenario may be `processing`.
- Do not skip earlier unfinished scenarios; reorder with `set_queue` before starting if the user changes priority.
- Do not add ontology layer fields here; this file records modeling direction, not model contents.

## Slice Quality

Good slices usually:
- involve at least two business object types;
- have conclusions backed by explicit evidence;
- require cross-object, cross-source, or cross-module reasoning;
- can state data scope and completeness expectations;
- can reuse the same object graph for follow-up questions.

Avoid slices that are:
- single-table field lookups;
- concept explanations without operational instances;
- unsupported by correct answers or evidence;
- invented only to demonstrate AI;
- attempts to model the whole enterprise at once.
