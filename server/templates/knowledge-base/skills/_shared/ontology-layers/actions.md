# Actions

Generates: `ontology/actions.yaml`

## Action Types

In the Ontology, users make changes to objects, properties, and relations by applying Actions. An Action is a single transaction that changes the properties or relations of one or more objects based on user-defined logic. Actions let users manage data in terms of business objectives instead of specific property edits.

An Action Type defines the set of changes or edits to objects, property values, and relations that a user can take at once. It also includes side effect behaviors that occur with action submission.

## YAML Shape

```yaml
actions:
  - id: AssignEmployee
    label: Assign Employee Role & Manager
    description: Update an employee's organizational role and reassign their reporting line.

    permissions:
      whoCanApply:
        roles: [hr_manager, hr_specialist, admin]
        condition: "user.organizationId == employee.organizationId"
      whoCanEditActionDefinition:
        roles: [admin, ontology_admin]

    parameters:
      - name: employee
        label: Target Employee
        type: Employee 
        required: true

      - name: newRole
        label: New Role
        type: EmployeeRole 
        required: true

      - name: newManager
        label: New Reporting Manager
        type: Employee
        required: true

    submissionCriteria:
      - id: CALLER_IS_AUTHORIZED_HR
        description: "Caller must be an active HR employee"
        expression: "user.roles.contains('hr_manager') || user.roles.contains('hr_specialist')"

      - id: TARGET_EMPLOYEE_ACTIVE
        description: "The targeted employee must be active"
        expression: "employee.status == 'ACTIVE'"

      - id: NEW_MANAGER_ACTIVE
        description: "The assigned manager must be active"
        expression: "newManager.status == 'ACTIVE'"

      - id: PREVENT_SELF_REPORTING
        description: "An employee cannot report to themselves"
        expression: "employee.employeeId != newManager.employeeId"

    changes:
      properties:
        - targetObject: employee
          property: role
          value: newRole

      relations:
        - operation: ADD # allowed: ADD | REMOVE
          from: employee
          relation: REPORTS_TO
          to: newManager

    sideEffects:
      notifications:
        - target: "employee.manager" 
          template: "EMPLOYEE_TRANSFERRED_OUT"
          params: { employeeId: "employee.employeeId" }

        - target: "newManager" 
          template: "NEW_DIRECT_REPORT_ASSIGNED"
          params: { employeeId: "employee.employeeId" }

      webhooks: []

    audit:
      required: true
      logLevel: Info # allowed: Info | Compliance
      reasonRequired: true
```

This YAML shape is a recommended baseline. You may add fields required by the business scenario, but generally preserve the baseline fields and structure.

## Action Type

Each Action should define:

- `id`: stable Action Type identifier;
- `label`: human-readable Action Type label;
- `description`: concise business purpose of the Action Type;
- `permissions`: who may apply the Action Type and who may edit the Action Type definition;
- `parameters`: typed inputs needed to submit the Action;
- `submissionCriteria`: structured checks that must pass before submission;
- `changes`: object property updates and relation changes performed by the transaction;
- `sideEffects`: non-ontology effects that occur with submission, such as notifications or webhooks;
- `audit`: audit requirement for submitted transactions.

## Rules

- `permissions` belongs to the Action Type. Do not create `permission_required` or a separate permission id just to express who may apply this Action.
- `permissions.whoCanApply.roles[]` defines roles or system identities allowed to attempt applying the Action Type.
- `permissions.whoCanApply.condition` defines ABAC-style dynamic checks over `user` and Action parameters, such as organization, department, region, or ownership boundaries.
- `permissions.whoCanEditActionDefinition.roles[]` defines who may change the Action Type definition itself. This is not the same as who may apply the Action.
- Permission extraction must be evidence-backed: fill role names, system identities, approvers, administrators, organization isolation, or specific action apply/edit rules only when the source text explicitly mentions them.
- If the source text does not mention who can apply the Action, still emit an explicit empty apply-role gate:
  ```yaml
  permissions:
    whoCanApply:
      roles: []
  ```
  `roles: []` means no special role threshold was extracted for applying this Action. Do not describe it as inheritance, and do not invent roles such as `admin`, `manager`, `operator`, or `viewer`.
- If the source text does not mention who can edit the Action Type definition, still emit an explicit empty definition-edit role gate:
  ```yaml
  permissions:
    whoCanEditActionDefinition:
      roles: []
  ```
  `roles: []` means no special role threshold was extracted for editing the Action Type definition. Do not infer ontology administrators or system owners.
- `permissions.whoCanApply` does not replace `submissionCriteria`. Apply permissions answer "who may attempt this Action"; `submissionCriteria` answers "whether this concrete submitted parameter set is valid." Both must pass when both are defined.
- `parameters` introduces Action-local parameter names. Each parameter must define `name`, `type`, and `required`; add `label` when it improves business readability.
- `parameters[].type` should follow this inference priority:
  - Object Reference: when the parameter represents a concrete business entity, such as the target object or a related object, use `object_types[].name` from `object-model.yaml`. Examples: `Employee`, `Asset`.
  - Enum / Value Set: when the parameter is a constrained status, category, or classification value, use the corresponding enum or value set name. Examples: `EmployeeRole`, `AssetStatus`.
  - Primitive Types: when the parameter is an ordinary scalar input, use a standard primitive such as `String`, `Integer`, `Double`, `Boolean`, `Instant`, or `Date`.
- Do not invent parameter types inside `actions.yaml`; add or reuse the appropriate Object Type, enum/value set, or primitive type from the object model context.
- `submissionCriteria[]` should use stable `id`, concise `description`, and an `expression` when the condition is explicit enough to encode.
- `submissionCriteria[].expression` may reference `user`, Action parameters, parameter property paths, known business rule ids, and known object model fields.
- Add submission criteria only when they are supported by source evidence or explicit user confirmation. Do not invent common-sense criteria that are not present in the source.
- Object, property, and relation changes belong in `changes`; do not hide ontology graph changes in `submissionCriteria` or `sideEffects`.
- `changes.properties[].targetObject` must resolve to a parameter; `property` must exist on that parameter's Object Type in `object-model.yaml`.
- `changes.relations[].operation` must be one of `ADD` or `REMOVE`. Use `ADD` for creating or attaching a relation, and `REMOVE` for unlinking or removing a relation. 
- `changes.relations[].relation` must reference a Relation Type from `object-model.yaml`; `from` and `to` must resolve to parameters whose types match the Relation Type endpoints.
- If an Action needs an Object Type, property, or Relation Type that does not exist, update `object-model.yaml` first. Do not define model structure only inside `actions.yaml`.
- `sideEffects.notifications[]` is for non-ontology notification behavior triggered after Action submission. Do not invent notification templates or recipients unless the source mentions them.
- `sideEffects.notifications[].target` must be either an Action parameter name, such as `newManager`, or a standard Ontology property path, such as `employee.manager`. Do not invent descriptive target names such as `old_manager`, `previous_target`, `previousManager`, or `former_owner`.
- Property-path notification targets are interpreted as pre-Action object state by default. For example, `employee.manager` means the employee's manager before this Action is applied.
- `sideEffects.notifications[].template` should be a stable template id only when the source names or implies a reusable notification template.
- `sideEffects.notifications[].params` maps template parameters to Action parameters or parameter property paths. Do not place ontology mutations in notification params.
- `sideEffects.webhooks[]` is for external integration callbacks. Leave it empty or omit it when no webhook is described.
- `audit.required` should be `true` for controlled write Actions unless the source explicitly says no audit is required.
- `audit.logLevel` must be `Info` or `Compliance`. Use `Info` for ordinary controlled-action logs. Use `Compliance` only when source evidence indicates regulated, policy-controlled, approval-sensitive, or compliance-grade audit needs.
- `audit.reasonRequired` should be `true` only when the source states that submitters must provide an operation reason, justification, or approval note.
- Keep reusable retrieval, calculation, decision, and implementation-backed function contracts in `functions.yaml`; Actions are for submitted changes and side effects.
