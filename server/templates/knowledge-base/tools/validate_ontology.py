#!/usr/bin/env python3
"""
Validate ontology-distill artifacts against the current ontology layer shapes.

Usage:
    python3 tools/validate_ontology.py
    python3 tools/validate_ontology.py ontology --stage final

`object-model.yaml` is required. Other ontology layer files are validated when
present, so partial batch artifacts can still be checked while final artifacts
get cross-layer reference validation.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("PyYAML is required. Install it or run in the Knowledge Fabric workspace.") from exc


ALLOWED_EDIT_MODES = {"ONLY_VIA_ACTIONS", "ALLOW_DIRECT_EDITS"}
ALLOWED_RELATION_OPERATIONS = {"ADD", "REMOVE"}
ALLOWED_AUDIT_LOG_LEVELS = {"Info", "Compliance"}
ALLOWED_FUNCTION_TYPES = {"CALCULATION", "DECISION", "RETRIEVAL", "RECOMMENDATION"}
ALLOWED_MISSING_VALUES = {"UNKNOWN", "NULL"}
PROHIBITED_FUNCTION_KEYS = {"permissions", "safety_guard", "side_effects", "sideEffects", "execution"}
SOURCE_FIELD_PART = re.compile(r"^[A-Za-z0-9_/-]+$")
PROPERTY_PATH_PART = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value).strip()
    return ""


def mapping_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def item_name(item: dict[str, Any]) -> str:
    return text(item.get("name")) or text(item.get("id"))


class Validator:
    def __init__(self, ontology_dir: Path) -> None:
        self.ontology_dir = ontology_dir
        self.errors: list[str] = []
        self.docs: dict[str, dict[str, Any]] = {}
        self.object_types: dict[str, dict[str, Any]] = {}
        self.object_properties: dict[str, dict[str, dict[str, Any]]] = {}
        self.relation_types: dict[str, dict[str, Any]] = {}

    def run(self) -> int:
        if not self.ontology_dir.exists():
            self.errors.append(f"[structure] ontology dir not found: {self.ontology_dir}")
            self.report()
            return 1

        model = self.load_yaml("object-model.yaml", required=True)
        if model is not None:
            self.validate_object_model(model)

        source_mappings = self.load_yaml("source-mappings.yaml")
        if source_mappings is not None:
            self.validate_source_mappings(source_mappings)

        actions = self.load_yaml("actions.yaml")
        if actions is not None:
            self.validate_actions(actions)

        functions = self.load_yaml("functions.yaml")
        if functions is not None:
            self.validate_functions(functions)

        self.report()
        return 1 if self.errors else 0

    def load_yaml(self, file_name: str, *, required: bool = False) -> dict[str, Any] | None:
        path = self.ontology_dir / file_name
        if not path.exists():
            if required:
                self.errors.append(f"[structure] {file_name} not found: {path}")
            return None

        try:
            parsed = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except Exception as exc:
            self.errors.append(f"[structure] {file_name}: {exc}")
            return None

        if not isinstance(parsed, dict):
            self.errors.append(f"[structure] {file_name} top-level YAML must be a mapping")
            return None

        self.docs[file_name] = parsed
        return parsed

    def validate_object_model(self, model: dict[str, Any]) -> None:
        object_types_raw = model.get("object_types")
        relation_types_raw = model.get("relation_types")
        object_type_relations_raw = model.get("object_type_relations", [])

        if not isinstance(object_types_raw, list):
            self.errors.append("[object-model] object_types must be a list")
            object_types: list[dict[str, Any]] = []
        else:
            object_types = mapping_items(object_types_raw)

        if not isinstance(relation_types_raw, list):
            self.errors.append("[object-model] relation_types must be a list")
            relation_types: list[dict[str, Any]] = []
        else:
            relation_types = mapping_items(relation_types_raw)

        for index, obj in enumerate(object_types):
            context = f"[object-model] object_types[{index}]"
            name = item_name(obj)
            if not name:
                self.errors.append(f"{context}.name must be a non-empty string")
                continue
            if name in self.object_types:
                self.errors.append(f"{context}.name duplicates Object Type: {name}")
            self.object_types[name] = obj
            self.object_properties.setdefault(name, {})

            self.validate_edit_mode(obj, context)
            self.validate_object_permissions(obj, context)
            self.collect_properties(name, obj, context)

        for index, relation in enumerate(relation_types):
            context = f"[object-model] relation_types[{index}]"
            name = item_name(relation)
            if not name:
                self.errors.append(f"{context}.name must be a non-empty string")
                continue
            if name in self.relation_types:
                self.errors.append(f"{context}.name duplicates Relation Type: {name}")
            self.relation_types[name] = relation

        for name, relation in self.relation_types.items():
            context = f"[object-model] relation_types[{name}]"
            self.validate_edit_mode(relation, context)
            self.validate_object_permissions(relation, context)
            self.validate_relation_type(name, relation, context)

        if not isinstance(object_type_relations_raw, list):
            self.errors.append("[object-model] object_type_relations must be a list")
            return

        for index, relation in enumerate(mapping_items(object_type_relations_raw)):
            self.validate_object_type_relation(relation, f"[object-model] object_type_relations[{index}]")

    def collect_properties(self, object_type: str, obj: dict[str, Any], context: str) -> None:
        properties_raw = obj.get("properties", [])
        if properties_raw in (None, []):
            return
        if not isinstance(properties_raw, list):
            self.errors.append(f"{context}.properties must be a list")
            return

        for prop_index, prop in enumerate(mapping_items(properties_raw)):
            prop_context = f"{context}.properties[{prop_index}]"
            prop_name = item_name(prop)
            if not prop_name:
                self.errors.append(f"{prop_context}.name must be a non-empty string")
                continue
            if prop_name in self.object_properties[object_type]:
                self.errors.append(f"{prop_context}.name duplicates property on {object_type}: {prop_name}")
            self.object_properties[object_type][prop_name] = prop

            value_type = text(prop.get("valueType"))
            if not value_type:
                self.errors.append(f"{prop_context}.valueType must be a non-empty string")

    def validate_edit_mode(self, item: dict[str, Any], context: str) -> None:
        edit_mode = text(item.get("editMode"))
        if edit_mode and edit_mode not in ALLOWED_EDIT_MODES:
            self.errors.append(f"{context}.editMode must be one of {sorted(ALLOWED_EDIT_MODES)}: {edit_mode}")

    def validate_object_permissions(self, item: dict[str, Any], context: str) -> None:
        permissions = item.get("permissions")
        if permissions in (None, {}, []):
            return
        if not isinstance(permissions, dict):
            self.errors.append(f"{context}.permissions must be a mapping or omitted")
            return

        for gate_name in ("whoCanView", "whoCanEditDirectly"):
            if gate_name not in permissions:
                continue
            gate = permissions.get(gate_name)
            gate_context = f"{context}.permissions.{gate_name}"
            if gate == []:
                continue
            self.validate_permission_gate(gate, gate_context, require_roles=False)

        if "whoCanEditDirectly" in permissions and text(item.get("editMode")) != "ALLOW_DIRECT_EDITS":
            self.errors.append(f"{context}.permissions.whoCanEditDirectly is only valid with editMode: ALLOW_DIRECT_EDITS")

    def validate_permission_gate(self, gate: Any, context: str, *, require_roles: bool) -> None:
        if not isinstance(gate, dict):
            self.errors.append(f"{context} must be a mapping with roles[]")
            return

        if "roles" not in gate:
            if require_roles:
                self.errors.append(f"{context}.roles must be present and may be an empty list")
        elif not isinstance(gate.get("roles"), list):
            self.errors.append(f"{context}.roles must be a list")
        elif not all(isinstance(role, str) and role.strip() for role in gate.get("roles", [])):
            self.errors.append(f"{context}.roles must contain only non-empty strings")

        condition = gate.get("condition")
        if condition is not None and not isinstance(condition, str):
            self.errors.append(f"{context}.condition must be a string when present")

    def validate_relation_type(self, name: str, relation: dict[str, Any], context: str) -> None:
        from_type = text(relation.get("from"))
        to_type = text(relation.get("to"))
        reverse_relation = text(relation.get("reverseRelation"))

        if not from_type:
            self.errors.append(f"{context}.from must be a non-empty string")
        elif from_type not in self.object_types:
            self.errors.append(f"{context}.from references unknown Object Type: {from_type}")

        if not to_type:
            self.errors.append(f"{context}.to must be a non-empty string")
        elif to_type not in self.object_types:
            self.errors.append(f"{context}.to references unknown Object Type: {to_type}")

        if not reverse_relation:
            self.errors.append(f"{context}.reverseRelation must reference the opposite Relation Type")
            return
        if reverse_relation not in self.relation_types:
            self.errors.append(f"{context}.reverseRelation references unknown Relation Type: {reverse_relation}")
            return

        reverse = self.relation_types[reverse_relation]
        reverse_back_ref = text(reverse.get("reverseRelation"))
        if reverse_back_ref and reverse_back_ref != name:
            self.errors.append(f"{context}.reverseRelation must be reciprocated by {reverse_relation}.reverseRelation")

        reverse_from = text(reverse.get("from"))
        reverse_to = text(reverse.get("to"))
        if from_type and to_type and reverse_from and reverse_to and (reverse_from != to_type or reverse_to != from_type):
            self.errors.append(f"{context}.reverseRelation endpoints must be reversed by {reverse_relation}")

    def validate_object_type_relation(self, relation: dict[str, Any], context: str) -> None:
        from_type = text(relation.get("from"))
        to_type = text(relation.get("to"))
        relation_type = text(relation.get("relation"))

        if not from_type:
            self.errors.append(f"{context}.from must be a non-empty string")
        elif from_type not in self.object_types:
            self.errors.append(f"{context}.from references unknown Object Type: {from_type}")

        if not to_type:
            self.errors.append(f"{context}.to must be a non-empty string")
        elif to_type not in self.object_types:
            self.errors.append(f"{context}.to references unknown Object Type: {to_type}")

        if not relation_type:
            self.errors.append(f"{context}.relation must be a non-empty string")
            return
        if relation_type not in self.relation_types:
            self.errors.append(f"{context}.relation references unknown Relation Type: {relation_type}")
            return

        relation_def = self.relation_types[relation_type]
        expected_from = text(relation_def.get("from"))
        expected_to = text(relation_def.get("to"))
        if from_type and expected_from and from_type != expected_from:
            self.errors.append(f"{context}.from must match Relation Type {relation_type}.from: {expected_from}")
        if to_type and expected_to and to_type != expected_to:
            self.errors.append(f"{context}.to must match Relation Type {relation_type}.to: {expected_to}")

    def validate_source_mappings(self, data: dict[str, Any]) -> None:
        mappings_raw = data.get("mappings", [])
        if not isinstance(mappings_raw, list):
            self.errors.append("[source-mappings] mappings must be a list")
            return

        for index, mapping in enumerate(mapping_items(mappings_raw)):
            context = f"[source-mappings] mappings[{index}]"
            object_type = text(mapping.get("objectType"))
            ontology_property = text(mapping.get("ontologyProperty"))
            value_type = text(mapping.get("valueType"))

            if not object_type:
                self.errors.append(f"{context}.objectType must be a non-empty string")
            elif object_type not in self.object_types:
                self.errors.append(f"{context}.objectType references unknown Object Type: {object_type}")

            property_def: dict[str, Any] | None = None
            if not ontology_property:
                self.errors.append(f"{context}.ontologyProperty must be a non-empty string")
            elif object_type in self.object_properties:
                property_def = self.object_properties[object_type].get(ontology_property)
                if property_def is None:
                    self.errors.append(f"{context}.ontologyProperty is not a property on {object_type}: {ontology_property}")

            if not value_type:
                self.errors.append(f"{context}.valueType must be a non-empty string")
            elif property_def is not None:
                expected_type = text(property_def.get("valueType"))
                if expected_type and value_type != expected_type:
                    self.errors.append(f"{context}.valueType must match {object_type}.{ontology_property}.valueType: {expected_type}")

            self.validate_source_field(mapping.get("sourceField"), f"{context}.sourceField")

            transform = mapping.get("transform")
            if transform is not None:
                transform_value = text(transform)
                if not transform_value:
                    self.errors.append(f"{context}.transform must be a non-empty controlled token")
                elif any(char.isspace() for char in transform_value):
                    self.errors.append(f"{context}.transform must be a controlled token, not descriptive prose: {transform_value}")

            if "nullable" in mapping and not isinstance(mapping.get("nullable"), bool):
                self.errors.append(f"{context}.nullable must be true or false")

            if "missingValue" in mapping:
                missing_value = "NULL" if mapping.get("missingValue") is None else text(mapping.get("missingValue"))
                if missing_value not in ALLOWED_MISSING_VALUES:
                    self.errors.append(f"{context}.missingValue must be UNKNOWN or NULL: {missing_value}")

    def validate_source_field(self, value: Any, context: str) -> None:
        source_field = text(value)
        if not source_field:
            self.errors.append(f"{context} must be a non-empty string")
            return
        parts = source_field.split(".")
        if len(parts) != 3 or any(not part for part in parts):
            self.errors.append(f"{context} must use <datasource_or_service>.<table_or_endpoint>.<field_name>: {source_field}")
            return
        for part in parts:
            if not SOURCE_FIELD_PART.match(part):
                self.errors.append(f"{context} contains an invalid path segment: {part}")

    def validate_actions(self, data: dict[str, Any]) -> None:
        actions_raw = data.get("actions", [])
        if not isinstance(actions_raw, list):
            self.errors.append("[actions] actions must be a list")
            return

        for index, action in enumerate(mapping_items(actions_raw)):
            context = f"[actions] actions[{index}]"
            if not item_name(action):
                self.errors.append(f"{context}.id must be a non-empty string")

            parameter_types = self.validate_action_parameters(action.get("parameters"), context)
            self.validate_action_permissions(action.get("permissions"), context)
            self.validate_submission_criteria(action.get("submissionCriteria"), context)
            self.validate_action_changes(action.get("changes"), parameter_types, context)
            self.validate_side_effects(action.get("sideEffects"), parameter_types, context)
            self.validate_audit(action.get("audit"), context)

    def validate_action_parameters(self, parameters: Any, action_context: str) -> dict[str, str]:
        parameter_types: dict[str, str] = {}
        if parameters is None:
            return parameter_types
        if not isinstance(parameters, list):
            self.errors.append(f"{action_context}.parameters must be a list")
            return parameter_types

        for index, parameter in enumerate(mapping_items(parameters)):
            context = f"{action_context}.parameters[{index}]"
            name = text(parameter.get("name"))
            type_ref = text(parameter.get("type"))
            if not name:
                self.errors.append(f"{context}.name must be a non-empty string")
            elif name in parameter_types:
                self.errors.append(f"{context}.name duplicates Action parameter: {name}")

            if not type_ref:
                self.errors.append(f"{context}.type must be a non-empty string")
            elif name:
                parameter_types[name] = type_ref

            if "required" in parameter and not isinstance(parameter.get("required"), bool):
                self.errors.append(f"{context}.required must be true or false")

        return parameter_types

    def validate_action_permissions(self, permissions: Any, action_context: str) -> None:
        if not isinstance(permissions, dict):
            self.errors.append(f"{action_context}.permissions must be present with whoCanApply and whoCanEditActionDefinition")
            return

        for gate_name in ("whoCanApply", "whoCanEditActionDefinition"):
            gate_context = f"{action_context}.permissions.{gate_name}"
            if gate_name not in permissions:
                self.errors.append(f"{gate_context} must be present with roles: [] when no role gate is extracted")
                continue
            self.validate_permission_gate(permissions.get(gate_name), gate_context, require_roles=True)

    def validate_submission_criteria(self, criteria: Any, action_context: str) -> None:
        if criteria is None:
            return
        if not isinstance(criteria, list):
            self.errors.append(f"{action_context}.submissionCriteria must be a list")
            return
        for index, criterion in enumerate(mapping_items(criteria)):
            context = f"{action_context}.submissionCriteria[{index}]"
            expression = criterion.get("expression")
            if expression is not None and not isinstance(expression, str):
                self.errors.append(f"{context}.expression must be a string when present")

    def validate_action_changes(self, changes: Any, parameter_types: dict[str, str], action_context: str) -> None:
        if changes is None:
            return
        if not isinstance(changes, dict):
            self.errors.append(f"{action_context}.changes must be a mapping")
            return

        properties = changes.get("properties", [])
        if properties is not None and not isinstance(properties, list):
            self.errors.append(f"{action_context}.changes.properties must be a list")
        else:
            for index, change in enumerate(mapping_items(properties)):
                self.validate_property_change(change, parameter_types, f"{action_context}.changes.properties[{index}]")

        relations = changes.get("relations", [])
        if relations is not None and not isinstance(relations, list):
            self.errors.append(f"{action_context}.changes.relations must be a list")
        else:
            for index, change in enumerate(mapping_items(relations)):
                self.validate_relation_change(change, parameter_types, f"{action_context}.changes.relations[{index}]")

    def validate_property_change(self, change: dict[str, Any], parameter_types: dict[str, str], context: str) -> None:
        target_object = text(change.get("targetObject"))
        property_name = text(change.get("property"))

        if not target_object:
            self.errors.append(f"{context}.targetObject must be a non-empty Action parameter name")
            return
        if target_object not in parameter_types:
            self.errors.append(f"{context}.targetObject references unknown Action parameter: {target_object}")
            return

        target_type = parameter_types[target_object]
        if target_type not in self.object_types:
            self.errors.append(f"{context}.targetObject parameter must be an Object Type, got {target_type}")
            return

        if not property_name:
            self.errors.append(f"{context}.property must be a non-empty string")
        elif property_name not in self.object_properties.get(target_type, {}):
            self.errors.append(f"{context}.property is not a property on {target_type}: {property_name}")

    def validate_relation_change(self, change: dict[str, Any], parameter_types: dict[str, str], context: str) -> None:
        operation = text(change.get("operation"))
        relation_ref = text(change.get("relation"))

        if operation not in ALLOWED_RELATION_OPERATIONS:
            self.errors.append(f"{context}.operation must be ADD or REMOVE: {operation}")

        relation_def: dict[str, Any] | None = None
        if not relation_ref:
            self.errors.append(f"{context}.relation must be a non-empty Relation Type name")
        elif relation_ref not in self.relation_types:
            self.errors.append(f"{context}.relation references unknown Relation Type: {relation_ref}")
        else:
            relation_def = self.relation_types[relation_ref]

        from_type = self.action_parameter_object_type(change.get("from"), parameter_types, f"{context}.from")
        to_type = self.action_parameter_object_type(change.get("to"), parameter_types, f"{context}.to")

        if relation_def is not None:
            expected_from = text(relation_def.get("from"))
            expected_to = text(relation_def.get("to"))
            if from_type and expected_from and from_type != expected_from:
                self.errors.append(f"{context}.from parameter type must match {relation_ref}.from: {expected_from}")
            if to_type and expected_to and to_type != expected_to:
                self.errors.append(f"{context}.to parameter type must match {relation_ref}.to: {expected_to}")

    def action_parameter_object_type(self, value: Any, parameter_types: dict[str, str], context: str) -> str:
        parameter_name = text(value)
        if not parameter_name:
            self.errors.append(f"{context} must be a non-empty Action parameter name")
            return ""
        if parameter_name not in parameter_types:
            self.errors.append(f"{context} references unknown Action parameter: {parameter_name}")
            return ""

        type_ref = parameter_types[parameter_name]
        if type_ref not in self.object_types:
            self.errors.append(f"{context} parameter must be an Object Type, got {type_ref}")
            return ""
        return type_ref

    def validate_side_effects(self, side_effects: Any, parameter_types: dict[str, str], action_context: str) -> None:
        if side_effects is None:
            return
        if not isinstance(side_effects, dict):
            self.errors.append(f"{action_context}.sideEffects must be a mapping")
            return

        notifications = side_effects.get("notifications", [])
        if notifications is not None and not isinstance(notifications, list):
            self.errors.append(f"{action_context}.sideEffects.notifications must be a list")
            return

        for index, notification in enumerate(mapping_items(notifications)):
            context = f"{action_context}.sideEffects.notifications[{index}]"
            self.validate_notification_target(notification.get("target"), parameter_types, f"{context}.target")

    def validate_notification_target(self, value: Any, parameter_types: dict[str, str], context: str) -> None:
        target = text(value)
        if not target:
            self.errors.append(f"{context} must be a parameter name or parameter property path")
            return

        if "." not in target:
            if target not in parameter_types:
                self.errors.append(f"{context} must be an Action parameter name, not a descriptive alias: {target}")
            return

        root, path = target.split(".", 1)
        if root not in parameter_types:
            self.errors.append(f"{context} property path root must be an Action parameter name: {target}")
            return
        if not path:
            self.errors.append(f"{context} property path must include at least one property segment: {target}")
            return

        for part in path.split("."):
            if not PROPERTY_PATH_PART.match(part):
                self.errors.append(f"{context} contains an invalid property path segment: {part}")

    def validate_audit(self, audit: Any, action_context: str) -> None:
        if audit is None:
            return
        if not isinstance(audit, dict):
            self.errors.append(f"{action_context}.audit must be a mapping")
            return

        log_level = text(audit.get("logLevel"))
        if log_level and log_level not in ALLOWED_AUDIT_LOG_LEVELS:
            self.errors.append(f"{action_context}.audit.logLevel must be Info or Compliance: {log_level}")

        for bool_key in ("required", "reasonRequired"):
            if bool_key in audit and not isinstance(audit.get(bool_key), bool):
                self.errors.append(f"{action_context}.audit.{bool_key} must be true or false")

    def validate_functions(self, data: dict[str, Any]) -> None:
        functions_raw = data.get("functions", [])
        if not isinstance(functions_raw, list):
            self.errors.append("[functions] functions must be a list")
            return

        for index, function in enumerate(mapping_items(functions_raw)):
            context = f"[functions] functions[{index}]"
            if not item_name(function):
                self.errors.append(f"{context}.id must be a non-empty string")

            for key in sorted(PROHIBITED_FUNCTION_KEYS & function.keys()):
                self.errors.append(f"{context}.{key} is not allowed in functions.yaml")

            function_type = text(function.get("type"))
            if function_type not in ALLOWED_FUNCTION_TYPES:
                self.errors.append(f"{context}.type must be one of {sorted(ALLOWED_FUNCTION_TYPES)}: {function_type}")

            self.validate_function_bindings(function.get("ontology_bindings"), context)
            self.validate_function_inputs(function.get("inputs"), context)
            self.validate_function_outputs(function.get("outputs"), context)

    def validate_function_bindings(self, bindings: Any, function_context: str) -> None:
        if not isinstance(bindings, dict):
            self.errors.append(f"{function_context}.ontology_bindings must be a mapping")
            return

        primary_object = text(bindings.get("primary_object"))
        if not primary_object:
            self.errors.append(f"{function_context}.ontology_bindings.primary_object must be a non-empty Object Type name")
        elif primary_object not in self.object_types:
            self.errors.append(f"{function_context}.ontology_bindings.primary_object references unknown Object Type: {primary_object}")

        related_objects = bindings.get("related_objects", [])
        if related_objects is None:
            return
        if not isinstance(related_objects, list):
            self.errors.append(f"{function_context}.ontology_bindings.related_objects must be a list")
            return
        for related in related_objects:
            related_object = text(related)
            if not related_object:
                self.errors.append(f"{function_context}.ontology_bindings.related_objects contains an empty Object Type reference")
            elif related_object not in self.object_types:
                self.errors.append(f"{function_context}.ontology_bindings.related_objects references unknown Object Type: {related_object}")

    def validate_function_inputs(self, inputs: Any, function_context: str) -> None:
        if not isinstance(inputs, dict):
            self.errors.append(f"{function_context}.inputs must be a mapping")
            return

        for name, spec in inputs.items():
            context = f"{function_context}.inputs.{name}"
            if not text(name):
                self.errors.append(f"{context} key must be a non-empty input name")
            if not isinstance(spec, dict):
                self.errors.append(f"{context} must be a mapping")
                continue
            if not text(spec.get("type")):
                self.errors.append(f"{context}.type must be a non-empty string")
            if "required" in spec and not isinstance(spec.get("required"), bool):
                self.errors.append(f"{context}.required must be true or false")

    def validate_function_outputs(self, outputs: Any, function_context: str) -> None:
        if not isinstance(outputs, dict):
            self.errors.append(f"{function_context}.outputs must be a mapping")
            return

        output_type = text(outputs.get("type"))
        if not output_type:
            self.errors.append(f"{function_context}.outputs.type must be a non-empty string")
        elif output_type == "Any":
            self.errors.append(f"{function_context}.outputs.type must not be Any")

        if output_type == "Object" and not isinstance(outputs.get("properties"), dict):
            self.errors.append(f"{function_context}.outputs.properties must be defined when outputs.type is Object")

        if outputs.get("is_array") is True and not (text(outputs.get("item_type")) or output_type.startswith("Array<")):
            self.errors.append(f"{function_context}.outputs.item_type is required when outputs.is_array is true")
        elif "is_array" in outputs and not isinstance(outputs.get("is_array"), bool):
            self.errors.append(f"{function_context}.outputs.is_array must be true or false")

    def report(self) -> None:
        if self.errors:
            print("Ontology validation failed:")
            for error in self.errors:
                print(f"- {error}")
        else:
            print("Ontology validation passed.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate ontology YAML layer references and controlled vocabularies.")
    parser.add_argument("ontology_dir", nargs="?", default="ontology", help="Directory containing ontology YAML files.")
    parser.add_argument("--stage", choices=["batch", "final"], default="final", help="Accepted for compatibility.")
    args = parser.parse_args()
    return Validator(Path(args.ontology_dir)).run()


if __name__ == "__main__":
    raise SystemExit(main())
