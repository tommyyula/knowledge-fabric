#!/usr/bin/env python3
"""
Build a layered business ontology review graph.

Usage:
    python tools/build_ontology_graph.py
    python tools/build_ontology_graph.py --open
    python tools/build_ontology_graph.py --ontology-dir ontology --output-dir graph

Outputs:
    graph/ontology-graph.json
    graph/ontology-graph.html

The graph reads ontology YAML layers and renders only stable ontology entities as
nodes. Ordinary fields stay inside node details or become edges to existing
ontology entities:
    object-model.yaml       -> Object Type nodes and Relation Type edges; labels/aliases support lookup; properties remain details
    object-instances.yaml   -> Object Instance nodes and Link Instance edges
    functions.yaml          -> Function nodes; inputs and outputs remain details
    actions.yaml            -> Action Type nodes; parameters, changes, criteria remain details
    business-rules.yaml     -> Business Rule nodes and references to existing objects/functions/actions
    source-mappings.yaml    -> source-to-property grounding stored on Object Type details
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import webbrowser
from datetime import date, datetime
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    print("Error: PyYAML is required. Install it with: pip install pyyaml")
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ONTOLOGY_DIR = REPO_ROOT / "ontology"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "graph"


def read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        parsed = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        print(f"Warning: cannot parse {path}: {exc}")
        return {}
    if not isinstance(parsed, dict):
        print(f"Warning: {path} did not parse to a YAML mapping; skipped")
        return {}
    return parsed


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def records(value: Any) -> list[dict[str, Any]]:
    return [item for item in as_list(value) if isinstance(item, dict)]


def layer_records(data: dict[str, Any], list_key: str) -> list[tuple[dict[str, Any], str]]:
    listed = records(data.get(list_key))
    if listed:
        return [(item, f"{list_key}[{index}]") for index, item in enumerate(listed)]
    if text(data.get("id")) or text(data.get("name")):
        return [(data, "")]
    return []


def text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value).strip()
    return ""


def item_id(item: dict[str, Any]) -> str:
    return text(item.get("id")) or text(item.get("name"))


def label(item: dict[str, Any], fallback: str) -> str:
    for key in ("label", "name", "title"):
        value = text(item.get(key))
        if value:
            return value
    object_type = text(item.get("object_type"))
    return f"{fallback} ({object_type})" if object_type else fallback


def compact(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): compact(item) for key, item in value.items() if item not in (None, "", [], {})}
    if isinstance(value, list):
        return [compact(item) for item in value if item not in (None, "", [], {})]
    return value


def json_default(value: Any) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError(f"Object of type {value.__class__.__name__} is not JSON serializable")


def json_for_script(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=json_default).replace("</", "<\\/")


LAYER_FILES = {
    "object_model": "object-model.yaml",
    "instances": "object-instances.yaml",
    "source_mappings": "source-mappings.yaml",
    "business_rules": "business-rules.yaml",
    "actions": "actions.yaml",
    "functions": "functions.yaml",
}

VIEW_LABELS = [
    ("object_language", "Objects & terms"),
    ("source_mappings", "Source mappings"),
    ("business_rules", "Business rules"),
    ("actions_permissions", "Actions & permissions"),
    ("functions", "Functions"),
    ("instances", "Instance facts"),
    ("__all__", "Full map"),
]


def merge_views(*values: Any) -> list[str]:
    merged: set[str] = set()
    for value in values:
        if isinstance(value, str):
            merged.add(value)
        else:
            merged.update(text(item) for item in as_list(value) if text(item))
    return sorted(merged)


def list_text(value: Any) -> list[str]:
    values: list[str] = []
    if isinstance(value, dict):
        iterable = value.values()
    elif isinstance(value, list):
        iterable = as_list(value)
    elif text(value):
        return [text(value)]
    else:
        return values
    for item in iterable:
        if isinstance(item, (dict, list)):
            values.extend(list_text(item))
        elif text(item):
            values.append(text(item))
    return values


def ref_variants(value: Any) -> list[str]:
    normalized = text(value)
    if not normalized:
        return []
    variants: list[str] = []

    def add(candidate: str) -> None:
        candidate = candidate.strip()
        if candidate and candidate not in variants:
            variants.append(candidate)

    add(normalized)
    if ":" in normalized:
        add(normalized.split(":", 1)[1])
    for candidate in list(variants):
        add(candidate.replace("_", "-"))
        add(candidate.replace("-", "_"))
    return variants


def label_aliases(item: dict[str, Any]) -> list[str]:
    aliases: list[str] = []
    aliases.extend(list_text(item.get("label")))
    aliases.extend(list_text(item.get("aliases")))
    return aliases


def ontology_property_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"ontology_property", "ontologyProperty"} and text(item):
                refs.append(text(item))
            elif isinstance(item, (dict, list)):
                refs.extend(ontology_property_refs(item))
    elif isinstance(value, list):
        for item in value:
            refs.extend(ontology_property_refs(item))
    return refs


def object_binding_refs(bindings: Any) -> list[str]:
    refs: list[str] = []
    if not isinstance(bindings, dict):
        return refs
    primary = text(bindings.get("primary_object")) or text(bindings.get("primaryObject"))
    if primary:
        refs.append(primary)
    refs.extend(list_text(bindings.get("related_objects")))
    refs.extend(list_text(bindings.get("relatedObjects")))
    return refs


def parameter_refs(value: Any) -> list[tuple[str, str]]:
    refs: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for name, spec in value.items():
            if isinstance(spec, dict):
                type_ref = text(spec.get("type")) or text(spec.get("object_type")) or text(spec.get("objectType"))
            else:
                type_ref = text(spec)
            if type_ref:
                refs.append((text(name), type_ref))
        return refs
    for item in as_list(value):
        if isinstance(item, dict):
            name = text(item.get("name")) or text(item.get("id")) or text(item.get("parameter"))
            type_ref = text(item.get("type")) or text(item.get("object_type")) or text(item.get("objectType"))
            if type_ref:
                refs.append((name, type_ref))
        elif text(item):
            refs.append(("", text(item)))
    return refs


def first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping.get(key)
    return None


def action_parameters(action: dict[str, Any]) -> tuple[str, list[tuple[str, str]]]:
    if "parameters" in action:
        return "parameters", parameter_refs(action.get("parameters"))
    return "inputs", parameter_refs(action.get("inputs"))


def action_submission_criteria(action: dict[str, Any]) -> tuple[str, list[Any]]:
    if "submissionCriteria" in action:
        return "submissionCriteria", as_list(action.get("submissionCriteria"))
    return "submission_criteria", as_list(action.get("submission_criteria"))


def action_changes(action: dict[str, Any]) -> dict[str, Any]:
    changes = action.get("changes")
    if isinstance(changes, dict):
        return changes
    effects = action.get("effects")
    return effects if isinstance(effects, dict) else {}


def fact_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"fact", "left", "right", "field", "property"} and text(item):
                refs.append(text(item))
            else:
                refs.extend(fact_refs(item))
    elif isinstance(value, list):
        for item in value:
            refs.extend(fact_refs(item))
    return refs


def property_key(object_type: str, prop: str) -> str:
    return f"{object_type}.{prop}"


class OntologyGraph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: dict[str, dict[str, Any]] = {}
        self.by_kind: dict[str, dict[str, str]] = {}
        self.relation_definitions: dict[str, dict[str, Any]] = {}
        self.relation_aliases: dict[str, str] = {}
        self.relation_endpoint_nodes: dict[str, list[tuple[str, str]]] = {}
        self.missing_refs: set[str] = set()
        self.missing_endpoint_refs: set[str] = set()

    def add_node(
        self,
        kind: str,
        key: Any,
        *,
        label_text: str = "",
        node_type: str,
        layer: str,
        source_file: str,
        yaml_path: str = "",
        business_object_type: str = "",
        details: Any = None,
        views: list[str] | None = None,
    ) -> str | None:
        normalized = text(key)
        if not normalized:
            return None
        node_id = f"{kind}:{normalized}"
        node_views = merge_views(views or [])
        if node_id in self.nodes:
            node = self.nodes[node_id]
            node["views"] = merge_views(node.get("views", []), node_views)
            if source_file:
                source_files = set(as_list(node.get("source_files")))
                source_files.add(source_file)
                node["source_files"] = sorted(source_files)
                node["source_file"] = ", ".join(node["source_files"])
            if yaml_path and not node.get("yaml_path"):
                node["yaml_path"] = yaml_path
            if details and not node.get("details"):
                node["details"] = compact(details)
            return node_id
        self.by_kind.setdefault(kind, {})[normalized] = node_id
        source_files = [source_file] if source_file else []
        self.nodes[node_id] = {
            "id": node_id,
            "key": normalized,
            "label": label_text or normalized,
            "group": kind,
            "object_type": node_type,
            "business_object_type": business_object_type or normalized,
            "layer": layer,
            "source_file": ", ".join(source_files),
            "source_files": source_files,
            "yaml_path": yaml_path,
            "views": node_views,
            "details": compact(details) if details is not None else {},
        }
        return node_id

    def add_alias(self, kind: str, key: Any, node_id: str | None) -> None:
        alias = text(key)
        if alias and node_id:
            self.by_kind.setdefault(kind, {})[alias] = node_id

    def add_node_views(self, node_id: str | None, views: list[str] | None) -> None:
        if node_id and node_id in self.nodes:
            self.nodes[node_id]["views"] = merge_views(self.nodes[node_id].get("views", []), views or [])

    def append_node_detail(self, node_id: str | None, key: str, value: Any, *, source_file: str = "") -> None:
        if not node_id or node_id not in self.nodes or value in (None, "", [], {}):
            return
        if source_file:
            node = self.nodes[node_id]
            source_files = set(as_list(node.get("source_files")))
            source_files.add(source_file)
            node["source_files"] = sorted(source_files)
            node["source_file"] = ", ".join(node["source_files"])
        details = self.nodes[node_id].setdefault("details", {})
        if not isinstance(details, dict):
            return
        values = details.setdefault(key, [])
        if isinstance(values, list):
            values.append(compact(value))

    def add_relation_definition(self, key: Any, *, source_file: str, yaml_path: str = "", details: Any = None) -> None:
        normalized = text(key)
        if not normalized:
            return
        self.relation_definitions[normalized] = {
            "key": normalized,
            "source_file": source_file,
            "yaml_path": yaml_path,
            "details": compact(details) if details is not None else {},
        }

    def add_relation_alias(self, alias: Any, relation_key: Any) -> None:
        alias_text = text(alias)
        normalized = text(relation_key)
        if alias_text and normalized:
            self.relation_aliases[alias_text] = normalized

    def relation_key(self, ref: Any) -> str:
        for normalized in ref_variants(ref):
            if normalized in self.relation_definitions or normalized in self.relation_endpoint_nodes:
                return normalized
            if normalized in self.relation_aliases:
                return self.relation_aliases[normalized]
        return ""

    def relation_label(self, ref: Any) -> str:
        normalized = self.relation_key(ref) or text(ref)
        definition = self.relation_definitions.get(normalized, {})
        details = definition.get("details")
        if isinstance(details, dict):
            return label(details, normalized)
        return normalized

    def is_relation_ref(self, ref: Any) -> bool:
        return bool(self.relation_key(ref))

    def add_relation_endpoint(self, relation_ref: Any, source: str | None, target: str | None) -> None:
        if not source or not target:
            return
        normalized = self.relation_key(relation_ref) or text(relation_ref)
        if not normalized:
            return
        endpoints = self.relation_endpoint_nodes.setdefault(normalized, [])
        pair = (source, target)
        if pair not in endpoints:
            endpoints.append(pair)

    def relation_targets(self, relation_ref: Any) -> list[tuple[str, str]]:
        normalized = self.relation_key(relation_ref)
        if not normalized:
            return []
        return list(self.relation_endpoint_nodes.get(normalized, []))

    def add_edge(
        self,
        source: str | None,
        target: str | None,
        edge_type: str,
        *,
        label_text: str = "",
        source_file: str = "",
        details: Any = None,
        views: list[str] | None = None,
        weight: float = 1.0,
        missing_endpoint: bool = False,
    ) -> None:
        if not source or not target:
            return
        edge_label = label_text or edge_type
        edge_id = f"edge:{source}->{target}:{edge_type}:{edge_label}"
        if edge_id in self.edges:
            edge = self.edges[edge_id]
            edge["views"] = merge_views(edge.get("views", []), views or [])
            edge["weight"] = max(float(edge.get("weight") or 1), weight)
            if source_file:
                source_files = set(as_list(edge.get("source_files")))
                source_files.add(source_file)
                edge["source_files"] = sorted(source_files)
                edge["source_file"] = ", ".join(edge["source_files"])
            return
        source_node = self.nodes.get(source, {})
        target_node = self.nodes.get(target, {})
        source_files = [source_file] if source_file else []
        self.edges[edge_id] = {
            "id": edge_id,
            "from": source,
            "to": target,
            "from_key": source_node.get("key", source),
            "to_key": target_node.get("key", target),
            "type": edge_type,
            "label": edge_label,
            "source_file": ", ".join(source_files),
            "source_files": source_files,
            "views": merge_views(views or []),
            "weight": weight,
            "missing_endpoint": missing_endpoint,
            "details": compact(details) if details is not None else {},
        }

    def resolve(self, ref: Any, preferred: list[str], *, context: str, source_file: str, views: list[str]) -> str | None:
        normalized = text(ref)
        if not normalized:
            return None
        for kind in preferred:
            for candidate in ref_variants(normalized):
                node_id = self.by_kind.get(kind, {}).get(candidate)
                if node_id:
                    self.add_node_views(node_id, views)
                    return node_id
        fallback_id = self.resolve_property_or_type(normalized)
        if fallback_id:
            self.add_node_views(fallback_id, views)
            return fallback_id
        self.missing_refs.add(normalized)
        return self.add_node(
            "missing_ref",
            f"{context}:{normalized}",
            label_text=f"{normalized} (missing)",
            node_type="Missing Reference",
            layer="review",
            source_file=source_file,
            business_object_type=normalized,
            details={"ref": normalized, "expected": preferred, "context": context},
            views=views,
        )

    def resolve_existing(self, ref: Any, preferred: list[str], *, views: list[str] | None = None) -> str | None:
        normalized = text(ref)
        if not normalized:
            return None
        for kind in preferred:
            for candidate in ref_variants(normalized):
                node_id = self.by_kind.get(kind, {}).get(candidate)
                if node_id:
                    self.add_node_views(node_id, views or [])
                    return node_id
        fallback_id = self.resolve_property_or_type(normalized)
        if fallback_id:
            self.add_node_views(fallback_id, views or [])
        return fallback_id

    def resolve_property_or_type(self, ref: str) -> str | None:
        for candidate in ref_variants(ref):
            if candidate in self.by_kind.get("property", {}):
                return self.by_kind["property"][candidate]
            if "." in candidate:
                obj, prop = candidate.split(".", 1)
                return self.by_kind.get("property", {}).get(property_key(obj, prop)) or self.by_kind.get("object_type", {}).get(obj)
            node_id = (
                self.by_kind.get("object_type", {}).get(candidate)
                or self.by_kind.get("semantic_ref", {}).get(candidate)
                or self.by_kind.get("function", {}).get(candidate)
                or self.by_kind.get("action", {}).get(candidate)
                or self.by_kind.get("business_rule", {}).get(candidate)
            )
            if node_id:
                return node_id
        return None


def relation_refs_in_text(graph: OntologyGraph, value: str) -> list[str]:
    if not value:
        return []
    found: list[str] = []
    relation_refs = sorted(set(graph.relation_definitions) | set(graph.relation_endpoint_nodes) | set(graph.relation_aliases))
    for ref in relation_refs:
        pattern = rf"(?<![A-Za-z0-9_]){re.escape(ref)}(?![A-Za-z0-9_])"
        if re.search(pattern, value):
            relation_key = graph.relation_key(ref) or ref
            if relation_key not in found:
                found.append(relation_key)
    return found


def relation_endpoint_nodes(graph: OntologyGraph, relation_ref: Any) -> list[str]:
    nodes: list[str] = []
    for source, target in graph.relation_targets(relation_ref):
        for node_id in (source, target):
            if node_id and node_id not in nodes:
                nodes.append(node_id)
    return nodes


def connect_reference_or_relation(
    graph: OntologyGraph,
    source_node: str | None,
    ref: Any,
    preferred: list[str],
    edge_type: str,
    *,
    label_text: str,
    source_file: str,
    views: list[str],
    context: str,
    details: Any = None,
    weight: float = 1.0,
) -> None:
    normalized = text(ref)
    if not source_node or not normalized:
        return
    relation_nodes = relation_endpoint_nodes(graph, normalized)
    if relation_nodes:
        for target in relation_nodes:
            graph.add_node_views(target, views)
            graph.add_edge(source_node, target, edge_type, label_text=normalized, source_file=source_file, details=details, views=views, weight=weight)
        return
    if graph.is_relation_ref(normalized):
        return
    target = graph.resolve(normalized, preferred, context=context, source_file=source_file, views=views)
    graph.add_edge(source_node, target, edge_type, label_text=label_text, source_file=source_file, details=details, views=views, weight=weight)


def connect_existing_reference_or_relation(
    graph: OntologyGraph,
    source_node: str | None,
    ref: Any,
    preferred: list[str],
    edge_type: str,
    *,
    label_text: str,
    source_file: str,
    views: list[str],
    details: Any = None,
    weight: float = 1.0,
) -> None:
    normalized = text(ref)
    if not source_node or not normalized:
        return
    relation_nodes = relation_endpoint_nodes(graph, normalized)
    if relation_nodes:
        for target in relation_nodes:
            graph.add_node_views(target, views)
            graph.add_edge(source_node, target, edge_type, label_text=normalized, source_file=source_file, details=details, views=views, weight=weight)
        return
    if graph.is_relation_ref(normalized):
        return
    target = graph.resolve_existing(normalized, preferred, views=views)
    if target:
        graph.add_edge(source_node, target, edge_type, label_text=label_text, source_file=source_file, details=details, views=views, weight=weight)


def load_docs(ontology_dir: Path) -> dict[str, dict[str, Any]]:
    return {layer: read_yaml(ontology_dir / file_name) for layer, file_name in LAYER_FILES.items()}


def add_object_model_nodes(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> None:
    data = docs["object_model"]
    source_file = LAYER_FILES["object_model"]
    for index, obj in enumerate(records(data.get("object_types"))):
        key = item_id(obj)
        object_node = graph.add_node(
            "object_type",
            key,
            label_text=label(obj, key),
            node_type="Business Object",
            layer="object_model",
            source_file=source_file,
            yaml_path=f"object_types[{index}]",
            business_object_type=key,
            details=obj,
            views=["object_language"],
        )
        for alias_ref in label_aliases(obj):
            for alias_variant in ref_variants(alias_ref):
                graph.add_alias("object_type", alias_variant, object_node)
        for semantic_ref in list_text(obj.get("semanticRefs")):
            for semantic_alias in ref_variants(semantic_ref):
                graph.add_alias("semantic_ref", semantic_alias, object_node)
        for prop in records(obj.get("properties")):
            prop_name = item_id(prop)
            if not prop_name:
                continue
            graph.add_alias("property", property_key(key, prop_name), object_node)
            for alias_ref in label_aliases(prop):
                for alias_variant in ref_variants(alias_ref):
                    graph.add_alias("property", property_key(key, alias_variant), object_node)
                    graph.add_alias("property", alias_variant, object_node)
            for semantic_ref in list_text(prop.get("semanticRefs")):
                for semantic_alias in ref_variants(semantic_ref):
                    graph.add_alias("property", semantic_alias, object_node)
    for index, relation in enumerate(records(data.get("relation_types"))):
        key = item_id(relation)
        graph.add_relation_definition(key, source_file=source_file, yaml_path=f"relation_types[{index}]", details=relation)
        for alias_ref in label_aliases(relation):
            for alias_variant in ref_variants(alias_ref):
                graph.add_relation_alias(alias_variant, key)
        for semantic_ref in list_text(relation.get("semanticRefs")):
            for semantic_alias in ref_variants(semantic_ref):
                graph.add_relation_alias(semantic_alias, key)
    for relation in records(data.get("object_type_relations")):
        from_ref = text(relation.get("from"))
        to_ref = text(relation.get("to"))
        relation_ref = text(relation.get("relation"))
        source = graph.resolve(from_ref, ["object_type"], context="object_type_relations.from", source_file=source_file, views=["object_language"])
        target = graph.resolve(to_ref, ["object_type"], context="object_type_relations.to", source_file=source_file, views=["object_language"])
        graph.add_relation_endpoint(relation_ref, source, target)
        graph.add_edge(source, target, "OBJECT_RELATION", label_text=graph.relation_label(relation_ref), source_file=source_file, details=relation, views=["object_language", "instances"], weight=2.2)


def missing_instance_node(graph: OntologyGraph, instance_key: str, source_file: str) -> str:
    graph.missing_endpoint_refs.add(instance_key)
    node = graph.add_node(
        "missing_instance",
        instance_key,
        label_text=f"{instance_key} (missing)",
        node_type="Missing Reference",
        layer="instances",
        source_file=source_file,
        business_object_type=instance_key,
        details={"id": instance_key, "missing": True},
        views=["instances"],
    )
    return node or f"missing_instance:{instance_key}"


def add_instance_nodes_and_edges(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> bool:
    data = docs["instances"]
    source_file = LAYER_FILES["instances"]
    if not data:
        return False
    for index, instance in enumerate(records(data.get("instances"))):
        instance_key = item_id(instance)
        object_type = text(instance.get("object_type")) or "unknown"
        node = graph.add_node(
            "instance",
            instance_key,
            label_text=label(instance, instance_key),
            node_type="Real Instance",
            layer="instances",
            source_file=source_file,
            yaml_path=f"instances[{index}]",
            business_object_type=object_type,
            details=instance,
            views=["instances"],
        )
        type_node = graph.resolve(object_type, ["object_type"], context="instances.object_type", source_file=source_file, views=["instances"])
        graph.add_edge(node, type_node, "INSTANCE_OF", label_text="is a", source_file=source_file, views=["instances"], weight=0.7)
    for instance in records(data.get("instances")):
        from_id = item_id(instance)
        for link in records(instance.get("links")):
            to_id = text(link.get("to"))
            relation = text(link.get("relation"))
            if not from_id or not to_id or not relation:
                continue
            source = graph.by_kind.get("instance", {}).get(from_id)
            target = graph.by_kind.get("instance", {}).get(to_id)
            missing = False
            if not source:
                missing = True
                source = missing_instance_node(graph, from_id, source_file)
            if not target:
                missing = True
                target = missing_instance_node(graph, to_id, source_file)
            graph.add_edge(source, target, "LINK_INSTANCE", label_text=relation, source_file=source_file, details=link, views=["instances"], weight=2.0, missing_endpoint=missing)
    return True


def add_source_mappings(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> None:
    data = docs["source_mappings"]
    source_file = LAYER_FILES["source_mappings"]
    for index, mapping in enumerate(records(data.get("mappings"))):
        object_type = text(mapping.get("objectType"))
        ontology_property = text(mapping.get("ontologyProperty"))
        target_ref = property_key(object_type, ontology_property) if object_type and ontology_property else f"mapping_{index}"
        target = graph.resolve_existing(target_ref, ["property", "object_type"], views=["source_mappings"])
        graph.append_node_detail(target, "source_mappings", {"yaml_path": f"mappings[{index}]", **mapping}, source_file=source_file)


def add_business_rules(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> None:
    data = docs["business_rules"]
    source_file = LAYER_FILES["business_rules"]
    for index, rule in enumerate(records(data.get("business_rules"))):
        key = item_id(rule)
        rule_node = graph.add_node(
            "business_rule",
            key,
            label_text=key,
            node_type="Business Rule",
            layer="business_rules",
            source_file=source_file,
            yaml_path=f"business_rules[{index}]",
            business_object_type=key,
            details=rule,
            views=["business_rules"],
        )
        for object_ref in list_text(rule.get("applies_to")):
            target = graph.resolve(object_ref, ["object_type"], context="business_rules.applies_to", source_file=source_file, views=["business_rules"])
            graph.add_edge(rule_node, target, "APPLIES_TO", label_text="applies to", source_file=source_file, views=["business_rules"], weight=0.85)
        for fact_ref in fact_refs(rule.get("when")):
            connect_existing_reference_or_relation(
                graph,
                rule_node,
                fact_ref,
                ["property", "object_type"],
                "READS_FACT",
                label_text="reads fact",
                source_file=source_file,
                views=["business_rules"],
                weight=0.55,
            )
        then = rule.get("then")
        if isinstance(then, dict) and isinstance(then.get("derive"), dict):
            derived = text(then["derive"].get("fact"))
            if derived:
                target = graph.resolve_property_or_type(derived)
                if target:
                    graph.add_edge(rule_node, target, "DERIVES", label_text="derives fact", source_file=source_file, details=then["derive"], views=["business_rules"], weight=0.8)


def add_functions(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> None:
    data = docs["functions"]
    source_file = LAYER_FILES["functions"]
    for function, yaml_path in layer_records(data, "functions"):
        key = item_id(function)
        graph.add_node(
            "function",
            key,
            label_text=text(function.get("name")) or key,
            node_type="Function",
            layer="functions",
            source_file=source_file,
            yaml_path=yaml_path,
            business_object_type=key,
            details=function,
            views=["functions"],
        )


def add_actions(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> None:
    data = docs["actions"]
    source_file = LAYER_FILES["actions"]
    for action, yaml_path in layer_records(data, "actions"):
        key = item_id(action)
        graph.add_node("action", key, label_text=label(action, key), node_type="Action Type", layer="actions", source_file=source_file, yaml_path=yaml_path, business_object_type=key, details=action, views=["actions_permissions"])


def refs_in_text(graph: OntologyGraph, value: str, kinds: list[str]) -> list[tuple[str, str]]:
    if not value:
        return []
    found: list[tuple[str, str]] = []
    for kind in kinds:
        for key in graph.by_kind.get(kind, {}):
            pattern = rf"(?<![A-Za-z0-9_]){re.escape(key)}(?![A-Za-z0-9_])"
            if re.search(pattern, value):
                found.append((kind, key))
    return found


def connect_business_rules(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> None:
    source_file = LAYER_FILES["business_rules"]
    for rule in records(docs["business_rules"].get("business_rules")):
        rule_node = graph.by_kind.get("business_rule", {}).get(item_id(rule))
        used_by = rule.get("used_by") if isinstance(rule.get("used_by"), dict) else {}
        for ref in list_text(used_by.get("functions")):
            target = graph.resolve(ref, ["function"], context="business_rules.used_by.functions", source_file=source_file, views=["business_rules", "functions"])
            graph.add_edge(rule_node, target, "USED_BY_FUNCTION", label_text="used by", source_file=source_file, views=["business_rules", "functions"], weight=1.25)
        for ref in list_text(used_by.get("actions")):
            target = graph.resolve(ref, ["action"], context="business_rules.used_by.actions", source_file=source_file, views=["business_rules", "actions_permissions"])
            graph.add_edge(rule_node, target, "USED_BY_ACTION", label_text="used by", source_file=source_file, views=["business_rules", "actions_permissions"], weight=1.25)


def connect_functions(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> None:
    source_file = LAYER_FILES["functions"]
    for function, _yaml_path in layer_records(docs["functions"], "functions"):
        function_node = graph.by_kind.get("function", {}).get(item_id(function))
        for ref in object_binding_refs(function.get("ontology_bindings")):
            target = graph.resolve(ref, ["object_type"], context="functions.ontology_bindings", source_file=source_file, views=["functions"])
            graph.add_edge(function_node, target, "BINDS_TO_OBJECT", label_text="binds to", source_file=source_file, views=["functions"], weight=1.1)
        for ref in ontology_property_refs(function.get("inputs")):
            target = graph.resolve_existing(ref, ["property", "object_type"], views=["functions"])
            graph.add_edge(function_node, target, "READS_PROPERTY", label_text="input property", source_file=source_file, details=ref, views=["functions"], weight=0.75)
        for ref in ontology_property_refs(function.get("outputs")):
            target = graph.resolve_existing(ref, ["property", "object_type"], views=["functions"])
            graph.add_edge(function_node, target, "RETURNS_PROPERTY", label_text="output property", source_file=source_file, details=ref, views=["functions"], weight=0.65)
        for ref in list_text(function.get("uses_rules")):
            target = graph.resolve(ref, ["business_rule"], context="functions.uses_rules", source_file=source_file, views=["functions", "business_rules"])
            graph.add_edge(function_node, target, "USES_RULE", label_text="uses rule", source_file=source_file, views=["functions", "business_rules"], weight=1.35)
        for ref in list_text(function.get("business_rules")):
            target = graph.resolve(ref, ["business_rule"], context="functions.business_rules", source_file=source_file, views=["functions", "business_rules"])
            graph.add_edge(function_node, target, "USES_RULE", label_text="uses rule", source_file=source_file, views=["functions", "business_rules"], weight=1.35)


def connect_actions(graph: OntologyGraph, docs: dict[str, dict[str, Any]]) -> None:
    source_file = LAYER_FILES["actions"]
    for action, _yaml_path in layer_records(docs["actions"], "actions"):
        action_node = graph.by_kind.get("action", {}).get(item_id(action))
        parameter_field, parameters = action_parameters(action)
        parameter_types = {param_name: ref for param_name, ref in parameters if param_name and ref}
        for param_name, ref in parameters:
            target = graph.resolve_existing(ref, ["object_type"], views=["actions_permissions"])
            graph.add_edge(action_node, target, "ACTION_PARAMETER", label_text=param_name or "parameter", source_file=source_file, views=["actions_permissions"], weight=1.0)
        criteria_field, criteria = action_submission_criteria(action)
        for criterion in criteria:
            criterion_text = text(criterion)
            if isinstance(criterion, dict):
                rule_ref = first_present(criterion, "rule", "ruleRequired", "rule_required", "businessRule", "business_rule", "businessRuleRequired", "business_rule_required")
                if text(rule_ref):
                    target = graph.resolve(rule_ref, ["business_rule"], context=f"actions.{criteria_field}.rule", source_file=source_file, views=["actions_permissions", "business_rules"])
                    graph.add_edge(action_node, target, "REQUIRES_RULE", label_text="requires rule", source_file=source_file, details=criterion, views=["actions_permissions", "business_rules"], weight=1.2)
                criterion_text = (
                    text(criterion.get("expression"))
                    or text(criterion.get("condition"))
                    or text(criterion.get("description"))
                    or text(criterion.get("criteria"))
                )
            for kind, ref in refs_in_text(graph, criterion_text, ["business_rule", "object_type", "property"]):
                target = graph.by_kind.get(kind, {}).get(ref)
                graph.add_node_views(target, ["actions_permissions"])
                edge_type = "REQUIRES_RULE" if kind == "business_rule" else "CRITERION_REFERENCES"
                graph.add_edge(action_node, target, edge_type, label_text="criterion", source_file=source_file, details=criterion, views=["actions_permissions"], weight=0.75)
        changes = action_changes(action)
        for change in records(changes.get("properties")):
            object_ref = text(change.get("targetObject")) or text(change.get("object"))
            target_ref = parameter_types.get(object_ref, object_ref)
            target = graph.resolve_existing(target_ref, ["object_type"], views=["actions_permissions"])
            graph.add_edge(action_node, target, "CHANGES_PROPERTY", label_text=text(change.get("property")) or "changes property", source_file=source_file, details=change, views=["actions_permissions"], weight=1.0)
        for change in records(changes.get("relations")):
            relation_ref = text(change.get("relation"))
            from_ref = parameter_types.get(text(change.get("from")), text(change.get("from")))
            to_ref = parameter_types.get(text(change.get("to")), text(change.get("to")))
            from_target = graph.resolve_existing(from_ref, ["object_type"], views=["actions_permissions"])
            to_target = graph.resolve_existing(to_ref, ["object_type"], views=["actions_permissions"])
            graph.add_edge(from_target, to_target, "CHANGES_RELATION", label_text=relation_ref or "changes relation", source_file=source_file, details=change, views=["actions_permissions"], weight=0.85)
            graph.add_edge(action_node, from_target, "RELATION_FROM", label_text="relation from", source_file=source_file, details=change, views=["actions_permissions"], weight=0.45)
            graph.add_edge(action_node, to_target, "RELATION_TO", label_text="relation to", source_file=source_file, details=change, views=["actions_permissions"], weight=0.45)
        for ref in list_text(changes.get("creates")):
            target = graph.resolve(ref, ["object_type"], context="actions.effects.creates", source_file=source_file, views=["actions_permissions"])
            graph.add_edge(action_node, target, "CREATES", label_text="creates", source_file=source_file, views=["actions_permissions"], weight=1.1)
        for update in records(changes.get("updates")):
            object_ref = text(update.get("object"))
            target = graph.resolve(object_ref, ["object_type"], context="actions.effects.updates.object", source_file=source_file, views=["actions_permissions"])
            graph.add_edge(action_node, target, "UPDATES", label_text="updates", source_file=source_file, details=update, views=["actions_permissions"], weight=1.0)
        for link in records(changes.get("links")):
            relation_ref = text(link.get("relation"))
            from_target = graph.resolve(link.get("from"), ["object_type"], context="actions.effects.links.from", source_file=source_file, views=["actions_permissions"])
            to_target = graph.resolve(link.get("to"), ["object_type"], context="actions.effects.links.to", source_file=source_file, views=["actions_permissions"])
            graph.add_edge(from_target, to_target, "CREATES_LINK", label_text=relation_ref or "creates link", source_file=source_file, details=link, views=["actions_permissions"], weight=0.85)
            graph.add_edge(action_node, from_target, "LINK_FROM", label_text="link from", source_file=source_file, details=link, views=["actions_permissions"], weight=0.45)
            graph.add_edge(action_node, to_target, "LINK_TO", label_text="link to", source_file=source_file, details=link, views=["actions_permissions"], weight=0.45)
        for rule_text in list_text(action.get("rules")):
            for kind, ref in refs_in_text(graph, rule_text, ["object_type", "property"]):
                target = graph.by_kind.get(kind, {}).get(ref)
                graph.add_node_views(target, ["actions_permissions"])
                graph.add_edge(action_node, target, "ACTION_RULE_REFERENCES", label_text="rule references", source_file=source_file, details=rule_text, views=["actions_permissions"], weight=0.65)
            for relation_ref in relation_refs_in_text(graph, rule_text):
                for target in relation_endpoint_nodes(graph, relation_ref):
                    graph.add_node_views(target, ["actions_permissions"])
                    graph.add_edge(action_node, target, "ACTION_RULE_REFERENCES", label_text=relation_ref, source_file=source_file, details=rule_text, views=["actions_permissions"], weight=0.7)
def build_graph(ontology_dir: Path) -> dict[str, Any]:
    docs = load_docs(ontology_dir)
    graph = OntologyGraph()

    add_object_model_nodes(graph, docs)
    add_functions(graph, docs)
    add_actions(graph, docs)
    add_business_rules(graph, docs)
    instances_loaded = add_instance_nodes_and_edges(graph, docs)
    add_source_mappings(graph, docs)

    connect_business_rules(graph, docs)
    connect_functions(graph, docs)
    connect_actions(graph, docs)

    degree: dict[str, int] = {node_id: 0 for node_id in graph.nodes}
    for edge in graph.edges.values():
        degree[edge["from"]] = degree.get(edge["from"], 0) + 1
        degree[edge["to"]] = degree.get(edge["to"], 0) + 1
    for node_id, count in degree.items():
        if node_id in graph.nodes:
            graph.nodes[node_id]["degree"] = count

    nodes = sorted(graph.nodes.values(), key=lambda item: (item.get("object_type", ""), item.get("label", "")))
    edges = sorted(graph.edges.values(), key=lambda item: (item.get("type", ""), item.get("from", ""), item.get("to", "")))
    node_types: dict[str, int] = {}
    edge_types: dict[str, int] = {}
    layer_counts: dict[str, int] = {}
    for node in nodes:
        node_type = str(node.get("object_type") or "unknown")
        layer = str(node.get("layer") or "unknown")
        node_types[node_type] = node_types.get(node_type, 0) + 1
        layer_counts[layer] = layer_counts.get(layer, 0) + 1
    for edge in edges:
        relation = str(edge.get("type") or "unknown")
        edge_types[relation] = edge_types.get(relation, 0) + 1

    view_counts = {
        view_id: sum(1 for node in nodes if view_id == "__all__" or view_id in as_list(node.get("views")))
        for view_id, _ in VIEW_LABELS
    }
    loaded_files = [file_name for layer, file_name in LAYER_FILES.items() if docs.get(layer)]
    instances_file = ontology_dir / LAYER_FILES["instances"]
    return {
        "nodes": nodes,
        "edges": edges,
        "summary": {
            "ontology_dir": str(ontology_dir),
            "loaded_files": loaded_files,
            "object_instances_file": str(instances_file),
            "object_instances_loaded": instances_loaded,
            "node_count": len(nodes),
            "edge_count": len(edges),
            "object_types": node_types,
            "relation_types": edge_types,
            "layer_counts": layer_counts,
            "views": [{"id": view_id, "label": label_text, "node_count": view_counts.get(view_id, 0)} for view_id, label_text in VIEW_LABELS],
            "missing_ref_count": len(graph.missing_refs),
            "missing_refs": sorted(graph.missing_refs),
            "missing_endpoint_count": len(graph.missing_endpoint_refs),
            "missing_endpoints": sorted(graph.missing_endpoint_refs),
            "instances": instances_loaded,
        },
    }


def render_html(graph_data: dict[str, Any]) -> str:
    template = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Business Knowledge Graph</title>
<style>
:root {
  color-scheme: dark;
  --bg: #080a0f;
  --panel: #10141c;
  --panel-2: #151b25;
  --line: rgba(151, 164, 184, 0.22);
  --line-strong: rgba(151, 164, 184, 0.38);
  --text: #edf5ff;
  --muted: #91a0b6;
  --accent: #55e6c1;
  --accent-2: #65a8ff;
  --danger: #fb7185;
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0;
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}
button, input, select { font: inherit; }
.app {
  background:
    radial-gradient(circle at 18% -10%, rgba(85, 230, 193, 0.18), transparent 30%),
    radial-gradient(circle at 84% 0%, rgba(101, 168, 255, 0.16), transparent 28%),
    linear-gradient(180deg, #0b0e15 0%, #080a0f 58%, #06080d 100%);
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 100vh;
}
.topbar {
  background: rgba(12, 16, 24, 0.88);
  border-bottom: 1px solid var(--line);
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.26);
  padding: 18px 22px 16px;
}
.title-row {
  align-items: flex-start;
  display: flex;
  gap: 18px;
  justify-content: space-between;
}
h1 {
  color: #f8fbff;
  font-size: 24px;
  letter-spacing: 0;
  line-height: 1.1;
  margin: 0;
}
.source {
  color: var(--muted);
  font-size: 13px;
  margin-top: 6px;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}
.stat {
  background: linear-gradient(180deg, rgba(21, 27, 37, 0.94), rgba(13, 17, 25, 0.94));
  border: 1px solid var(--line);
  border-radius: 8px;
  min-width: 116px;
  padding: 9px 11px;
}
.stat b {
  color: #ffffff;
  display: block;
  font-size: 23px;
  line-height: 1.05;
}
.stat span {
  color: var(--muted);
  font-size: 12px;
}
.toolbar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 15px;
}
.toolbar input,
.toolbar select {
  background: #0d121b;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  height: 38px;
  outline: none;
  padding: 0 12px;
}
.toolbar input {
  flex: 1 1 320px;
  min-width: min(430px, 100%);
}
.toolbar input::placeholder { color: #6f7e94; }
.toolbar input:focus,
.toolbar select:focus {
  border-color: rgba(85, 230, 193, 0.72);
  box-shadow: 0 0 0 3px rgba(85, 230, 193, 0.13);
}
.toolbar button {
  align-items: center;
  background: #141a24;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: #dce8f7;
  cursor: pointer;
  display: inline-flex;
  height: 38px;
  padding: 0 13px;
}
.toolbar button:hover {
  background: #182130;
  border-color: rgba(101, 168, 255, 0.66);
  color: #ffffff;
}
.toggle {
  align-items: center;
  background: #0d121b;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: #c4d1e4;
  display: inline-flex;
  gap: 7px;
  height: 38px;
  padding: 0 11px;
}
.toggle input { accent-color: var(--accent); }
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
  padding: 14px;
}
.graph-shell {
  background: #080c13;
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02), 0 20px 48px rgba(0, 0, 0, 0.24);
  min-height: calc(100vh - 182px);
  overflow: hidden;
  position: relative;
}
.graph-overlay {
  left: 14px;
  pointer-events: none;
  position: absolute;
  right: 424px;
  top: 14px;
  z-index: 3;
}
.label-bar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.label-chip {
  align-items: center;
  backdrop-filter: blur(12px);
  background: rgba(12, 17, 26, 0.68);
  border: 1px solid rgba(151, 164, 184, 0.24);
  border-radius: 999px;
  color: #dce8f7;
  cursor: pointer;
  display: inline-flex;
  gap: 7px;
  height: 30px;
  max-width: 220px;
  padding: 0 10px;
  pointer-events: auto;
}
.label-chip:hover {
  border-color: rgba(85, 230, 193, 0.56);
  color: #ffffff;
}
.label-chip.legend {
  cursor: default;
  pointer-events: none;
}
.label-chip.legend:hover {
  border-color: rgba(151, 164, 184, 0.24);
  color: #dce8f7;
}
.label-chip.disabled {
  color: #6f7e94;
  opacity: 0.58;
}
.label-dot {
  border-radius: 999px;
  display: inline-block;
  flex: 0 0 auto;
  height: 9px;
  width: 9px;
}
.label-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#graph {
  background:
    radial-gradient(circle at center, rgba(85, 230, 193, 0.08), transparent 34%),
    linear-gradient(rgba(116, 139, 171, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(116, 139, 171, 0.08) 1px, transparent 1px),
    #070b12;
  background-size: auto, 34px 34px, 34px 34px, auto;
  cursor: grab;
  display: block;
  height: 100%;
  min-height: 640px;
  width: 100%;
}
#graph:active { cursor: grabbing; }
.edge-group {
  transition: opacity 180ms ease;
}
.edge-group.dimmed { opacity: 0.12; }
.edge {
  fill: none;
  stroke: #8ba3c2;
  stroke-linecap: round;
  stroke-opacity: 0.42;
  stroke-width: 0.63;
}
.edge-hit-zone {
  fill: none;
  pointer-events: stroke;
  stroke: transparent;
  stroke-linecap: round;
  stroke-width: 12;
}
.edge:hover,
.edge-group:hover .edge {
  stroke: #b8d2f2;
  stroke-opacity: 0.86;
  stroke-width: 1.03;
}
.edge.missing {
  stroke: var(--danger);
  stroke-dasharray: 5 4;
}
.edge.selected {
  stroke: var(--accent);
  stroke-opacity: 0.96;
  stroke-width: 1.27;
  filter: drop-shadow(0 0 5px rgba(85, 230, 193, 0.38));
}
.edge-label {
  fill: #c0cde0;
  font-size: 9.8px;
  opacity: 0;
  paint-order: stroke;
  pointer-events: none;
  stroke: rgba(7, 11, 18, 0.96);
  stroke-linejoin: round;
  stroke-width: 3.4px;
  transition: opacity 120ms ease;
}
.edge-label.visible,
.edge-group:hover .edge-label {
  opacity: 1;
}
.node {
  cursor: pointer;
  transition: opacity 180ms ease;
}
.node.dimmed { opacity: 0.14; }
.node-halo {
  opacity: 0.17;
  pointer-events: none;
}
.node-hit-zone {
  fill: transparent;
  pointer-events: all;
}
.node-core {
  stroke: rgba(255, 255, 255, 0.84);
  stroke-width: 2;
  filter: drop-shadow(0 5px 12px rgba(0, 0, 0, 0.34));
}
.node:hover .node-halo,
.node.selected .node-halo { opacity: 0.32; }
.node:hover .node-core {
  stroke: #ffffff;
  stroke-width: 2.8;
}
.node.selected .node-core {
  stroke: var(--accent);
  stroke-width: 3.2;
  filter: drop-shadow(0 0 13px rgba(85, 230, 193, 0.55));
}
.node.missing .node-core {
  stroke: var(--danger);
  stroke-dasharray: 4 3;
}
.node-label {
  fill: #e6edf7;
  font-size: 10.5px;
  font-weight: 650;
  paint-order: stroke;
  pointer-events: none;
  stroke: rgba(7, 11, 18, 0.96);
  stroke-linejoin: round;
  stroke-width: 5px;
  text-anchor: middle;
}
.node-type-label {
  fill: #aebbd0;
  font-size: 10px;
  paint-order: stroke;
  pointer-events: none;
  stroke: rgba(7, 11, 18, 0.96);
  stroke-linejoin: round;
  stroke-width: 4px;
  text-anchor: middle;
}
.empty-state {
  align-items: center;
  background: rgba(8, 10, 15, 0.86);
  color: #b4c1d3;
  display: none;
  inset: 0;
  justify-content: center;
  padding: 24px;
  position: absolute;
  text-align: center;
}
.inspector {
  backdrop-filter: blur(14px);
  background: linear-gradient(180deg, rgba(19, 24, 34, 0.78), rgba(12, 16, 24, 0.84));
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.22);
  display: flex;
  flex-direction: column;
  height: calc(100% - 28px);
  overflow: hidden;
  pointer-events: none;
  position: absolute;
  right: 14px;
  top: 14px;
  transform: translateX(calc(100% + 24px));
  transition: opacity 180ms ease, transform 220ms ease;
  width: min(390px, calc(100% - 28px));
  z-index: 4;
  opacity: 0;
}
.inspector.open {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
}
.inspector-header {
  border-bottom: 1px solid var(--line);
  padding: 16px 16px 13px;
}
.inspector-header h2 {
  color: #f5f9ff;
  font-size: 16px;
  margin: 0;
  overflow-wrap: anywhere;
}
.inspector-header p {
  color: var(--muted);
  font-size: 12px;
  margin: 5px 0 0;
  overflow-wrap: anywhere;
}
.inspector-content {
  overflow: auto;
  padding: 14px 16px 18px;
}
.notice {
  background: rgba(251, 113, 133, 0.11);
  border: 1px solid rgba(251, 113, 133, 0.38);
  border-radius: 8px;
  color: #fecdd3;
  margin-bottom: 12px;
  padding: 10px 11px;
}
.section {
  border-top: 1px solid var(--line);
  margin-top: 14px;
  padding-top: 13px;
}
.section:first-child {
  border-top: 0;
  margin-top: 0;
  padding-top: 0;
}
.section h3 {
  color: #9fb0c8;
  font-size: 12px;
  letter-spacing: 0;
  margin: 0 0 9px;
  text-transform: uppercase;
}
.kv {
  align-items: start;
  display: grid;
  gap: 9px;
  grid-template-columns: minmax(88px, 30%) minmax(0, 1fr);
  margin: 7px 0;
}
.kv > div { min-width: 0; }
.key {
  color: #7f8ea4;
  overflow-wrap: anywhere;
}
code {
  background: #1a2230;
  border: 1px solid rgba(151, 164, 184, 0.20);
  border-radius: 6px;
  color: #dbeafe;
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 2px 6px;
  white-space: normal;
  word-break: normal;
}
.detail-grid {
  display: grid;
  gap: 0;
}
.detail-row {
  align-items: start;
  border-top: 1px solid rgba(151, 164, 184, 0.10);
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(104px, 32%) minmax(0, 1fr);
  min-width: 0;
  padding: 9px 0;
}
.detail-row:first-child {
  border-top: 0;
  padding-top: 0;
}
.detail-row:last-child {
  padding-bottom: 0;
}
.detail-row.full {
  gap: 7px;
  grid-template-columns: minmax(0, 1fr);
}
.detail-key {
  color: #8ea0b8;
  font-size: 12px;
  line-height: 1.35;
  min-width: 0;
  overflow-wrap: anywhere;
}
.detail-value {
  color: #dce6f3;
  line-height: 1.45;
  min-width: 0;
  overflow-wrap: anywhere;
}
.detail-value code {
  vertical-align: top;
}
.detail-outline {
  display: grid;
  gap: 7px;
  min-width: 0;
}
.detail-branch {
  margin-left: calc(var(--indent, 0) * 12px);
  min-width: 0;
}
.detail-branch-label {
  color: #9babc2;
  font-size: 12px;
  line-height: 1.35;
  margin: 2px 0 5px;
  overflow-wrap: anywhere;
}
.detail-leaf {
  align-items: start;
  display: grid;
  gap: 8px;
  grid-template-columns: minmax(78px, 28%) minmax(0, 1fr);
  margin-left: calc(var(--indent, 0) * 12px);
  min-width: 0;
}
.detail-leaf-key {
  color: #8ea0b8;
  font-size: 12px;
  line-height: 1.45;
  min-width: 0;
  overflow-wrap: anywhere;
}
.detail-leaf-values {
  align-items: flex-start;
  display: grid;
  gap: 6px;
  justify-items: start;
  min-width: 0;
}
.detail-leaf-box {
  background: rgba(148, 163, 184, 0.055);
  border: 1px solid rgba(151, 164, 184, 0.18);
  border-radius: 6px;
  box-sizing: border-box;
  color: #dbeafe;
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 4px 7px;
  white-space: normal;
  word-break: normal;
}
.detail-leaf-box.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.detail-leaf-box.text {
  color: #d4deeb;
  display: block;
  font-family: inherit;
  line-height: 1.45;
  width: 100%;
}
.inspector button {
  background: #172130;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: #dbeafe;
  cursor: pointer;
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 5px 8px;
  text-align: left;
}
.inspector button:hover {
  border-color: rgba(85, 230, 193, 0.62);
  color: #ffffff;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.chips button {
  border-radius: 999px;
  padding: 5px 9px;
}
.summary-list {
  display: grid;
  gap: 7px;
}
.summary-row {
  align-items: center;
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto;
}
.summary-name {
  color: #aebbd0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.summary-count {
  background: rgba(85, 230, 193, 0.10);
  border: 1px solid rgba(85, 230, 193, 0.24);
  border-radius: 999px;
  color: #e8fff8;
  min-width: 28px;
  padding: 1px 7px;
  text-align: center;
}
@media (max-width: 980px) {
  .title-row { display: block; }
  .stats {
    justify-content: flex-start;
    margin-top: 12px;
  }
  .graph-shell { min-height: 640px; }
  .graph-overlay {
    right: 14px;
    top: 12px;
  }
  .inspector {
    height: min(520px, calc(100% - 80px));
    top: auto;
    bottom: 14px;
    width: calc(100% - 28px);
  }
}
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="title-row">
      <div>
        <h1>Business Knowledge Graph</h1>
        <div class="source" id="source-file"></div>
      </div>
      <div class="stats" aria-label="Graph statistics">
        <div class="stat"><b id="total-nodes">0</b><span>nodes</span></div>
        <div class="stat"><b id="total-edges">0</b><span>relationships</span></div>
        <div class="stat"><b id="visible-nodes">0</b><span>visible nodes</span></div>
        <div class="stat"><b id="visible-edges">0</b><span>visible relationships</span></div>
      </div>
    </div>
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search object, rule, function, action access, evidence">
      <select id="type-filter" aria-label="Filter by business view"></select>
      <button id="fit-button" type="button">Fit graph</button>
      <button id="reset-button" type="button">Reset layout</button>
    </div>
  </header>
  <main class="workspace">
    <section class="graph-shell" aria-label="Business knowledge graph canvas">
      <div class="graph-overlay">
        <div class="label-bar" id="label-bar" aria-label="Visible object type filters"></div>
      </div>
      <svg id="graph" role="img" aria-label="Business knowledge relationship graph">
        <defs>
          <marker id="arrow" markerWidth="4" markerHeight="4" refX="3.26" refY="1.26" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L3.31,1.26 L0,2.51 Z" fill="#8ba3c2"></path>
          </marker>
          <marker id="arrow-selected" markerWidth="4" markerHeight="4" refX="3.26" refY="1.26" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L3.31,1.26 L0,2.51 Z" fill="#55e6c1"></path>
          </marker>
          <marker id="arrow-missing" markerWidth="4" markerHeight="4" refX="3.26" refY="1.26" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L3.31,1.26 L0,2.51 Z" fill="#fb7185"></path>
          </marker>
        </defs>
        <g id="viewport">
          <g id="edge-layer"></g>
          <g id="node-layer"></g>
        </g>
      </svg>
      <div class="empty-state" id="empty-state"></div>
      <aside class="inspector" id="inspector" aria-label="Graph details">
        <div class="inspector-header">
          <h2 id="inspector-title">Graph Overview</h2>
          <p id="inspector-subtitle">Select a node or relationship to inspect its source details and YAML location.</p>
        </div>
        <div class="inspector-content" id="inspector-content"></div>
      </aside>
    </section>
  </main>
</div>
<script id="graph-data" type="application/json">__GRAPH_DATA__</script>
<script>
const SVG_NS = "http://www.w3.org/2000/svg";
const graphData = JSON.parse(document.getElementById("graph-data").textContent);
const summary = graphData.summary || {};
const palette = ["#55e6c1", "#65a8ff", "#f7b955", "#f97090", "#a78bfa", "#34d399", "#f97316", "#22d3ee", "#facc15", "#c084fc", "#94a3b8"];
const typeColor = new Map();

const svg = document.getElementById("graph");
const viewport = document.getElementById("viewport");
const edgeLayer = document.getElementById("edge-layer");
const nodeLayer = document.getElementById("node-layer");
const searchInput = document.getElementById("search");
const typeFilter = document.getElementById("type-filter");
const emptyState = document.getElementById("empty-state");
const labelBar = document.getElementById("label-bar");
const inspector = document.getElementById("inspector");
let view = { x: 0, y: 0, k: 1 };
let active = { kind: "", id: "" };
let dragState = null;
let animationFrame = 0;
let simulationAlpha = 0;
let simulationTicks = 0;
let fitWhenSettled = false;
let expandingNodeId = "";
let expandPulseUntil = 0;
const hiddenTypes = new Set();
const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function stableColor(value) {
  const key = String(value || "unknown");
  if (key === "missing") return "#fb7185";
  if (!typeColor.has(key)) {
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    typeColor.set(key, palette[Math.abs(hash) % palette.length]);
  }
  return typeColor.get(key);
}

function truncate(value, max = 30) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function shortPath(value) {
  const parts = String(value || "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || value || "";
}

function searchable(value) {
  try {
    return JSON.stringify(value || {}).toLowerCase();
  } catch {
    return "";
  }
}

const nodes = (graphData.nodes || []).map((node, index) => ({
  ...node,
  color: stableColor(node.object_type || node.group),
  degree: Number(node.degree || 0),
  fx: null,
  fy: null,
  index,
  pinned: false,
  properties: node.details || {},
  radius: Math.min(29, node.object_type === "Missing Reference" ? 14 : 14 + Math.sqrt(Math.max(Number(node.degree || 0), 1)) * 3.1),
  search: `${node.label || ""} ${node.key || ""} ${node.object_type || ""} ${node.business_object_type || ""} ${node.group || ""} ${(node.views || []).join(" ")} ${searchable(node.details)}`.toLowerCase(),
  visible: true,
  vx: 0,
  vy: 0,
  x: 0,
  y: 0
}));
const nodeById = new Map(nodes.map(node => [node.id, node]));
const edges = (graphData.edges || [])
  .map(edge => ({
    ...edge,
    source: nodeById.get(edge.from),
    target: nodeById.get(edge.to),
    parallelOffset: 0,
    search: `${edge.label || ""} ${edge.type || ""} ${edge.from_key || ""} ${edge.to_key || ""} ${edge.source_file || ""} ${(edge.views || []).join(" ")} ${searchable(edge.details)}`.toLowerCase(),
    visible: true,
    weight: Math.max(0.5, Number(edge.weight || (edge.details && edge.details.weight) || 1))
  }))
  .filter(edge => edge.source && edge.target);
const edgeById = new Map(edges.map(edge => [edge.id, edge]));
assignParallelEdges();

function svgElement(tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value !== null && value !== undefined) element.setAttribute(key, String(value));
  });
  return element;
}

function nodeRadius(node) {
  if (Number.isFinite(node.radius)) return node.radius;
  if (node.object_type === "Missing Reference") return 14;
  return Math.min(29, 14 + Math.sqrt(Math.max(node.degree, 1)) * 3.1);
}

function edgeWeight(edge) {
  return Math.max(0.5, Math.min(4, Number(edge.weight || 1)));
}

function assignParallelEdges() {
  const groups = new Map();
  edges.forEach(edge => {
    const key = [edge.from, edge.to].sort().join("::");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  });
  groups.forEach(group => {
    if (group.length === 1) {
      group[0].parallelOffset = 0;
      return;
    }
    const endpoints = [...new Set(group.flatMap(edge => [edge.from, edge.to]))].sort();
    group
      .sort((a, b) => `${a.from}:${a.to}:${a.id}`.localeCompare(`${b.from}:${b.to}:${b.id}`))
      .forEach((edge, index) => {
        const rawOffset = (index - (group.length - 1) / 2) * 28;
        const directionSign = edge.from === endpoints[0] ? 1 : -1;
        edge.parallelOffset = rawOffset * directionSign;
      });
  });
}

function initialLayout() {
  const count = Math.max(nodes.length, 1);
  const baseRadius = Math.max(180, Math.sqrt(count) * 58);
  nodes.forEach((node, index) => {
    const ring = 1 + Math.floor(index / Math.max(8, Math.ceil(Math.sqrt(count) * 2)));
    const angle = (index / count) * Math.PI * 2;
    const radius = baseRadius * (0.72 + ring * 0.18);
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
    node.vx = 0;
    node.vy = 0;
  });
}

function simulationStep(alpha = 1) {
  const visibleNodes = nodes.filter(node => node.visible);
  const visibleEdges = edges.filter(edge => edge.visible);
  if (visibleNodes.length < 2) return 0;
  for (let i = 0; i < visibleNodes.length; i += 1) {
    for (let j = i + 1; j < visibleNodes.length; j += 1) {
      const a = visibleNodes[i];
      const b = visibleNodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist2 = dx * dx + dy * dy;
      if (dist2 < 0.01) {
        dx = (Math.random() - 0.5) * 0.1;
        dy = (Math.random() - 0.5) * 0.1;
        dist2 = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(dist2);
      const labelBuffer = Math.min(34, Math.max(String(a.label || "").length, String(b.label || "").length) * 0.55);
      const minDistance = nodeRadius(a) + nodeRadius(b) + 34 + labelBuffer;
      const charge = Math.min(7.5, 8200 / Math.max(dist2, 90)) * alpha;
      const collision = dist < minDistance ? (minDistance - dist) * 0.055 * alpha : 0;
      const force = charge + collision;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }
  visibleEdges.forEach(edge => {
    const a = edge.source;
    const b = edge.target;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const weight = edgeWeight(edge);
    const desired = 168 + Math.min(86, String(edge.label || "").length * 2.4) - weight * 14;
    const force = (dist - desired) * (0.012 + weight * 0.006) * alpha;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  });
  let speed = 0;
  visibleNodes.forEach(node => {
    if (node.fx !== null && node.fy !== null) {
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
      return;
    }
    node.vx += (0 - node.x) * 0.0019 * alpha;
    node.vy += (0 - node.y) * 0.0019 * alpha;
    node.vx *= 0.84;
    node.vy *= 0.84;
    node.x += node.vx;
    node.y += node.vy;
    speed += Math.hypot(node.vx, node.vy);
  });
  return speed / visibleNodes.length;
}

function settleLayout(iterations = 130) {
  let alpha = Math.max(0.2, simulationAlpha || 0.85);
  for (let step = 0; step < iterations; step += 1) {
    simulationStep(alpha);
    alpha *= 0.975;
  }
  simulationAlpha = 0;
}

function stopSimulation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  simulationAlpha = 0;
  simulationTicks = 0;
}

function startSimulation(options = {}) {
  const alpha = options.alpha ?? 0.85;
  fitWhenSettled = fitWhenSettled || Boolean(options.fit);
  simulationAlpha = Math.max(simulationAlpha, alpha);
  simulationTicks = 0;
  if (reduceMotion) {
    settleLayout(120);
    render();
    if (fitWhenSettled) {
      fitGraph();
      fitWhenSettled = false;
    }
    return;
  }
  if (!animationFrame) animationFrame = requestAnimationFrame(animateSimulation);
}

function animateSimulation() {
  animationFrame = 0;
  const visibleNodes = nodes.filter(node => node.visible);
  if (visibleNodes.length < 2) {
    render();
    if (fitWhenSettled) {
      fitGraph();
      fitWhenSettled = false;
    }
    return;
  }
  const steps = simulationAlpha > 0.55 ? 2 : 1;
  let speed = 0;
  for (let step = 0; step < steps; step += 1) speed = simulationStep(simulationAlpha);
  simulationTicks += 1;
  render();
  if (fitWhenSettled && simulationTicks === 12) fitGraph();
  simulationAlpha *= 0.972;
  if ((simulationAlpha > 0.018 || speed > 0.08) && simulationTicks < 260) {
    animationFrame = requestAnimationFrame(animateSimulation);
    return;
  }
  simulationAlpha = 0;
  if (fitWhenSettled) {
    fitGraph();
    fitWhenSettled = false;
  }
}

function edgeGeometry(edge) {
  const source = edge.source;
  const target = edge.target;
  if (source.id === target.id) {
    const radius = nodeRadius(source) + 9;
    return {
      path: `M${source.x},${source.y - radius} C${source.x + 82},${source.y - 92} ${source.x + 92},${source.y + 72} ${source.x + radius},${source.y}`,
      label: { x: source.x + 70, y: source.y - 58 }
    };
  }
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const sr = nodeRadius(source) + 2;
  const tr = nodeRadius(target) + 8;
  const x1 = source.x + (dx / dist) * sr;
  const y1 = source.y + (dy / dist) * sr;
  const x2 = target.x - (dx / dist) * tr;
  const y2 = target.y - (dy / dist) * tr;
  const offset = edge.parallelOffset || 0;
  if (Math.abs(offset) < 1) {
    return {
      path: `M${x1},${y1} L${x2},${y2}`,
      label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6 }
    };
  }
  const nx = -dy / dist;
  const ny = dx / dist;
  const cx = (x1 + x2) / 2 + nx * offset;
  const cy = (y1 + y2) / 2 + ny * offset;
  return {
    path: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`,
    label: {
      x: 0.25 * x1 + 0.5 * cx + 0.25 * x2,
      y: 0.25 * y1 + 0.5 * cy + 0.25 * y2 - 6
    }
  };
}

function edgePath(edge) {
  return edgeGeometry(edge).path;
}

function edgeLabelPosition(edge) {
  return edgeGeometry(edge).label;
}

function shouldShowEdgeLabel(edge, selected, focus, visibleEdges) {
  const label = String(edge.label || edge.type || "").toLowerCase();
  const noisyLabels = new Set(["is a", "applies to", "used by", "reads fact", "derives fact"]);
  if (selected) return true;
  if (focus && focus.edgeIds.has(edge.id) && focus.edgeIds.size <= 24 && !noisyLabels.has(label)) return true;
  if (visibleEdges.length <= 45 && view.k >= 1.12 && !noisyLabels.has(label)) return true;
  return false;
}

function applyTransform() {
  viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
}

function openInspector() {
  inspector.classList.add("open");
}

function closeInspector() {
  inspector.classList.remove("open");
}

function focusContext() {
  if (active.kind === "node" && active.id) {
    const nodeIds = new Set([active.id]);
    const edgeIds = new Set();
    edges.forEach(edge => {
      if (edge.source.id === active.id || edge.target.id === active.id) {
        edgeIds.add(edge.id);
        nodeIds.add(edge.source.id);
        nodeIds.add(edge.target.id);
      }
    });
    return { nodeIds, edgeIds };
  }
  if (active.kind === "edge" && active.id) {
    const edge = edgeById.get(active.id);
    if (!edge) return null;
    return {
      nodeIds: new Set([edge.source.id, edge.target.id]),
      edgeIds: new Set([edge.id])
    };
  }
  return null;
}

function isDimmedNode(node, focus) {
  return Boolean(focus && !focus.nodeIds.has(node.id));
}

function isDimmedEdge(edge, focus) {
  return Boolean(focus && !focus.edgeIds.has(edge.id));
}

function nodeInnerLabel(node) {
  const maxChars = Math.max(5, Math.floor(nodeRadius(node) / 2.15));
  return truncate(node.label || node.key, maxChars);
}

function renderLabelBar() {
  const visibleCounts = new Map();
  const viewCounts = new Map();
  nodes.forEach(node => {
    const type = node.object_type || "unknown";
    if (nodeInSelectedView(node)) viewCounts.set(type, (viewCounts.get(type) || 0) + 1);
    if (node.visible) visibleCounts.set(type, (visibleCounts.get(type) || 0) + 1);
  });
  const entries = Array.from(viewCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 22);
  const canFilterTypes = typeFilteringEnabled();
  const hiddenControl = canFilterTypes && hiddenTypes.size
    ? `<button class="label-chip" type="button" data-clear-types="true"><span class="label-text">Show all types</span></button>`
    : "";
  labelBar.innerHTML = `${hiddenControl}${entries.map(([type, total]) => {
    const count = visibleCounts.get(type) || 0;
    const disabled = canFilterTypes && hiddenTypes.has(type);
    const tagName = canFilterTypes ? "button" : "span";
    const attrs = canFilterTypes ? `type="button" data-type="${escapeHtml(type)}"` : `aria-disabled="true"`;
    return `<${tagName} class="label-chip${disabled ? " disabled" : ""}${canFilterTypes ? "" : " legend"}" ${attrs} title="${escapeHtml(type)}">
      <span class="label-dot" style="background:${stableColor(type)}"></span>
      <span class="label-text">${escapeHtml(type)}</span>
      <span>${disabled ? `hidden/${escapeHtml(total)}` : escapeHtml(count)}</span>
    </${tagName}>`;
  }).join("")}`;
  if (canFilterTypes) {
    labelBar.querySelectorAll("[data-type]").forEach(button => {
      button.addEventListener("click", () => dispatchGraphEvent("toggle-type", { type: button.dataset.type }));
    });
    const clearButton = labelBar.querySelector("[data-clear-types]");
    if (clearButton) clearButton.addEventListener("click", () => dispatchGraphEvent("clear-type-filters"));
  }
}

function dispatchGraphEvent(type, payload = {}) {
  if (type === "select-node" && payload.node) selectNode(payload.node);
  if (type === "select-edge" && payload.edge) selectEdge(payload.edge);
  if (type === "clear-selection") clearSelection();
  if (type === "toggle-type" && payload.type) {
    if (!typeFilteringEnabled()) return;
    if (hiddenTypes.has(payload.type)) hiddenTypes.delete(payload.type);
    else hiddenTypes.add(payload.type);
    applyFilters({ resimulate: true, fit: true });
  }
  if (type === "clear-type-filters") {
    if (!typeFilteringEnabled()) return;
    hiddenTypes.clear();
    applyFilters({ resimulate: true, fit: true });
  }
  if (type === "reset-layout") resetLayout();
  if (type === "fit-graph") fitGraph();
  if (type === "expand-node" && payload.node) expandNode(payload.node);
}

function render() {
  edgeLayer.replaceChildren();
  nodeLayer.replaceChildren();
  const visibleNodes = nodes.filter(node => node.visible);
  const visibleEdges = edges.filter(edge => edge.visible);
  const focus = focusContext();
  emptyState.style.display = visibleNodes.length ? "none" : "flex";
  emptyState.textContent = nodes.length
    ? "No visible nodes match the current filters."
    : "No ontology graph nodes found. Expected ontology/*.yaml layer files.";

  visibleEdges.forEach(edge => {
    const selected = active.kind === "edge" && active.id === edge.id;
    const dimmed = isDimmedEdge(edge, focus);
    const geometry = edgeGeometry(edge);
    const group = svgElement("g", {
      class: `edge-group${dimmed ? " dimmed" : ""}`,
      tabindex: "0",
      role: "button"
    });
    const hitPath = svgElement("path", {
      class: "edge-hit-zone",
      d: geometry.path
    });
    const path = svgElement("path", {
      class: `edge${edge.missing_endpoint ? " missing" : ""}${selected ? " selected" : ""}`,
      d: geometry.path,
      "marker-end": edge.missing_endpoint ? "url(#arrow-missing)" : selected ? "url(#arrow-selected)" : "url(#arrow)"
    });
    group.addEventListener("pointerdown", event => event.stopPropagation());
    group.addEventListener("click", event => {
      event.stopPropagation();
      dispatchGraphEvent("select-edge", { edge });
    });
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        dispatchGraphEvent("select-edge", { edge });
      }
    });
    group.appendChild(hitPath);
    group.appendChild(path);
    const position = geometry.label;
    const showLabel = shouldShowEdgeLabel(edge, selected, focus, visibleEdges);
    const text = svgElement("text", { class: `edge-label${showLabel ? " visible" : ""}`, x: position.x, y: position.y, "text-anchor": "middle" });
    text.textContent = truncate(edge.label || edge.type || "relation", 34);
    group.appendChild(text);
    edgeLayer.appendChild(group);
  });

  visibleNodes.forEach(node => {
    const selected = active.kind === "node" && active.id === node.id;
    const dimmed = isDimmedNode(node, focus);
    const expanding = expandingNodeId === node.id && performance.now() < expandPulseUntil;
    const group = svgElement("g", {
      class: `node${node.object_type === "Missing Reference" ? " missing" : ""}${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}${expanding ? " selected" : ""}`,
      transform: `translate(${node.x},${node.y})`,
      tabindex: "0",
      role: "button"
    });
    const halo = svgElement("circle", { class: "node-halo", r: nodeRadius(node) + 9, fill: node.color });
    const circle = svgElement("circle", { class: "node-core", r: nodeRadius(node), fill: node.color });
    const hitZone = svgElement("circle", { class: "node-hit-zone", r: nodeRadius(node) * 2.05 });
    const title = svgElement("title");
    title.textContent = `${node.label} | ${node.business_object_type || node.object_type || "unknown"}`;
    group.appendChild(title);
    group.appendChild(halo);
    group.appendChild(circle);
    const text = svgElement("text", { class: "node-label", x: 0, y: 0, "dominant-baseline": "central" });
    text.textContent = nodeInnerLabel(node);
    group.appendChild(text);
    const typeText = svgElement("text", { class: "node-type-label", x: 0, y: nodeRadius(node) + 16 });
    typeText.textContent = truncate(node.business_object_type || node.object_type || "unknown", 18);
    group.appendChild(typeText);
    group.appendChild(hitZone);
    group.addEventListener("pointerdown", event => startNodeDrag(event, node));
    group.addEventListener("dblclick", event => {
      event.preventDefault();
      event.stopPropagation();
      dispatchGraphEvent("expand-node", { node });
    });
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        dispatchGraphEvent("select-node", { node });
      }
    });
    nodeLayer.appendChild(group);
  });
  applyTransform();
  updateVisibleStats();
}

function fitGraph() {
  const visibleNodes = nodes.filter(node => node.visible);
  const rect = svg.getBoundingClientRect();
  const width = rect.width || 1000;
  const height = rect.height || 620;
  if (!visibleNodes.length) {
    view = { x: width / 2, y: height / 2, k: 1 };
    applyTransform();
    return;
  }
  const xs = visibleNodes.map(node => node.x);
  const ys = visibleNodes.map(node => node.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const padding = 110;
  const scale = Math.max(0.1, Math.min(3.2, Math.min((width - padding) / graphWidth, (height - padding) / graphHeight)));
  view.k = scale;
  view.x = width / 2 - ((minX + maxX) / 2) * scale;
  view.y = height / 2 - ((minY + maxY) / 2) * scale;
  applyTransform();
}

function graphPoint(event) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - view.x) / view.k,
    y: (event.clientY - rect.top - view.y) / view.k
  };
}

function startNodeDrag(event, node) {
  event.preventDefault();
  event.stopPropagation();
  svg.setPointerCapture(event.pointerId);
  const point = graphPoint(event);
  node.fx = point.x;
  node.fy = point.y;
  dragState = { kind: "node", node, start: point, moved: false };
  startSimulation({ alpha: 0.52 });
}

svg.addEventListener("pointerdown", event => {
  event.preventDefault();
  svg.setPointerCapture(event.pointerId);
  dragState = {
    kind: "pan",
    startX: event.clientX,
    startY: event.clientY,
    viewX: view.x,
    viewY: view.y,
    moved: false
  };
});

svg.addEventListener("pointermove", event => {
  if (!dragState) return;
  if (dragState.kind === "node") {
    const point = graphPoint(event);
    const dx = point.x - dragState.start.x;
    const dy = point.y - dragState.start.y;
    if (Math.hypot(dx, dy) > 2) dragState.moved = true;
    dragState.node.x = point.x;
    dragState.node.y = point.y;
    dragState.node.fx = point.x;
    dragState.node.fy = point.y;
    dragState.node.vx = 0;
    dragState.node.vy = 0;
    render();
    return;
  }
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  if (Math.hypot(dx, dy) > 2) dragState.moved = true;
  view.x = dragState.viewX + dx;
  view.y = dragState.viewY + dy;
  applyTransform();
});

svg.addEventListener("pointerup", event => {
  if (!dragState) return;
  if (dragState.kind === "node") {
    dragState.node.fx = null;
    dragState.node.fy = null;
    if (!dragState.moved) dispatchGraphEvent("select-node", { node: dragState.node });
    else startSimulation({ alpha: 0.42 });
  }
  if (dragState.kind === "pan" && !dragState.moved) dispatchGraphEvent("clear-selection");
  try { svg.releasePointerCapture(event.pointerId); } catch {}
  dragState = null;
});

svg.addEventListener("pointercancel", event => {
  if (dragState && dragState.kind === "node") {
    dragState.node.fx = null;
    dragState.node.fy = null;
    startSimulation({ alpha: 0.32 });
  }
  try { svg.releasePointerCapture(event.pointerId); } catch {}
  dragState = null;
});

svg.addEventListener("wheel", event => {
  event.preventDefault();
  const rect = svg.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const gx = (sx - view.x) / view.k;
  const gy = (sy - view.y) / view.k;
  const factor = event.deltaY < 0 ? 1.12 : 0.89;
  view.k = Math.max(0.1, Math.min(5, view.k * factor));
  view.x = sx - gx * view.k;
  view.y = sy - gy * view.k;
  applyTransform();
}, { passive: false });

function selectedGraphView() {
  return typeFilter.value || "object_language";
}

function nodeInSelectedView(node) {
  const viewId = selectedGraphView();
  return viewId === "__all__" || (node.views || []).includes(viewId);
}

function edgeInSelectedView(edge) {
  const viewId = selectedGraphView();
  return viewId === "__all__" || (edge.views || []).includes(viewId);
}

function typeFilteringEnabled() {
  return selectedGraphView() === "__all__";
}

function nodeTypeAllowed(node) {
  const type = node.object_type || "unknown";
  return nodeInSelectedView(node) && (!typeFilteringEnabled() || !hiddenTypes.has(type));
}

function applyFilters(options = {}) {
  const query = searchInput.value.trim().toLowerCase();
  nodes.forEach(node => {
    node.visible = nodeTypeAllowed(node) && (!query || node.search.includes(query));
  });
  if (query) {
    edges.forEach(edge => {
      const edgeMatches = edge.search.includes(query) || edge.source.search.includes(query) || edge.target.search.includes(query);
      if (edgeMatches && edgeInSelectedView(edge) && nodeTypeAllowed(edge.source) && nodeTypeAllowed(edge.target)) {
        edge.source.visible = true;
        edge.target.visible = true;
      }
    });
  }
  edges.forEach(edge => {
    edge.visible = edgeInSelectedView(edge) && edge.source.visible && edge.target.visible && (!query || edge.search.includes(query) || edge.source.search.includes(query) || edge.target.search.includes(query));
  });
  const activeNode = active.kind === "node" ? nodeById.get(active.id) : null;
  const activeEdge = active.kind === "edge" ? edgeById.get(active.id) : null;
  if (activeNode && !activeNode.visible) {
    active = { kind: "", id: "" };
    closeInspector();
  }
  if (activeEdge && !activeEdge.visible) {
    active = { kind: "", id: "" };
    closeInspector();
  }
  render();
  renderLabelBar();
  if (options.resimulate || options.fit) {
    startSimulation({ alpha: options.resimulate ? 0.62 : 0.36, fit: Boolean(options.fit) });
  }
}

function updateVisibleStats() {
  document.getElementById("visible-nodes").textContent = nodes.filter(node => node.visible).length;
  document.getElementById("visible-edges").textContent = edges.filter(edge => edge.visible).length;
}

function buildTypeFilter() {
  typeFilter.replaceChildren();
  (summary.views || [{ id: "object_language", label: "Objects & terms", node_count: nodes.length }])
    .forEach(viewInfo => {
      const option = document.createElement("option");
      option.value = viewInfo.id;
      option.textContent = `${viewInfo.label} (${viewInfo.node_count})`;
      typeFilter.appendChild(option);
    });
  typeFilter.value = "object_language";
}

function isRenderableValue(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && !(Array.isArray(value) && !value.length)
    && !(isObjectValue(value) && !Object.keys(value).length);
}

function isObjectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObjectList(value) {
  return Array.isArray(value) && value.some(item => isObjectValue(item));
}

function isComplexDetailValue(value) {
  return isObjectValue(value) || isObjectList(value);
}

const DETAIL_TOP_LEVEL_IDENTITY_KEYS = new Set(["id", "name", "label", "title"]);
const DETAIL_TECHNICAL_KEYS = new Set(["layer", "source_file", "source_files", "yaml_path"]);

function cleanDetails(value, depth = 0) {
  if (Array.isArray(value)) {
    return value
      .map(item => cleanDetails(item, depth + 1))
      .filter(item => isRenderableValue(item));
  }
  if (isObjectValue(value)) {
    const result = {};
    Object.entries(value).forEach(([key, item]) => {
      if (DETAIL_TECHNICAL_KEYS.has(key)) return;
      if (depth === 0 && DETAIL_TOP_LEVEL_IDENTITY_KEYS.has(key)) return;
      const cleaned = cleanDetails(item, depth + 1);
      if (isRenderableValue(cleaned)) result[key] = cleaned;
    });
    return result;
  }
  return value;
}

function renderBreakableText(value) {
  return escapeHtml(value).replace(/([._/:-])/g, "$1<wbr>");
}

function isLongText(value) {
  const content = String(value ?? "");
  return content.length > 34 || /\s/.test(content);
}

function renderLeafValue(value) {
  const className = isLongText(value) ? "detail-leaf-box text" : "detail-leaf-box mono";
  return `<span class="${className}">${renderBreakableText(value)}</span>`;
}

function renderLeafValues(values) {
  return `<div class="detail-leaf-values">${values.map(item => renderLeafValue(item)).join("")}</div>`;
}

function renderOutline(value, depth = 0) {
  const indent = Math.min(depth, 6);
  if (Array.isArray(value)) {
    if (!value.length) return "";
    if (isObjectList(value)) {
      return `<div class="detail-outline">${value.map((item, index) => {
        const itemLabel = value.length > 1 ? `<div class="detail-branch-label">Item ${index + 1}</div>` : "";
        const itemDepth = value.length > 1 ? depth + 1 : depth;
        return `<div class="detail-branch" style="--indent:${indent}">${itemLabel}${renderOutline(item, itemDepth)}</div>`;
      }).join("")}</div>`;
    }
    return renderLeafValues(value);
  }
  if (isObjectValue(value)) {
    const rows = Object.entries(value).filter(([, item]) => isRenderableValue(item));
    if (!rows.length) return "";
    return `<div class="detail-outline">${rows.map(([key, item]) => {
      if (isComplexDetailValue(item)) {
        return `<div class="detail-branch" style="--indent:${indent}"><div class="detail-branch-label">${renderBreakableText(key)}</div>${renderOutline(item, depth + 1)}</div>`;
      }
      if (Array.isArray(item)) {
        return `<div class="detail-leaf" style="--indent:${indent}"><div class="detail-leaf-key">${renderBreakableText(key)}</div>${renderLeafValues(item)}</div>`;
      }
      return `<div class="detail-leaf" style="--indent:${indent}"><div class="detail-leaf-key">${renderBreakableText(key)}</div><div class="detail-leaf-values">${renderLeafValue(item)}</div></div>`;
    }).join("")}</div>`;
  }
  return renderLeafValue(value);
}

function renderValue(value, depth = 0) {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) {
    if (!value.length) return "";
    if (isObjectList(value)) return renderOutline(value, 0);
    return renderLeafValues(value);
  }
  if (typeof value === "object") {
    const rows = Object.entries(value).filter(([, item]) => isRenderableValue(item));
    if (!rows.length) return "";
    if (depth > 0) return renderOutline(value, 0);
    return `<div class="detail-grid">${rows.map(([key, item]) => {
      const complex = isComplexDetailValue(item);
      const rendered = complex ? renderOutline(item, 0) : renderValue(item, depth + 1);
      return `<div class="detail-row${complex ? " full" : ""}"><div class="detail-key" title="${escapeHtml(key)}">${renderBreakableText(key)}</div><div class="detail-value">${rendered}</div></div>`;
    }).join("")}</div>`;
  }
  return renderLeafValue(value);
}

function relationButtons(node) {
  const related = edges.filter(edge => edge.source.id === node.id || edge.target.id === node.id);
  if (!related.length) return "";
  return `<div class="section"><h3>Relations</h3><div class="chips">${
    related.slice(0, 40).map(edge => {
      const other = edge.source.id === node.id ? edge.target : edge.source;
      return `<button type="button" data-edge-id="${escapeHtml(edge.id)}">${escapeHtml(edge.label)}: ${escapeHtml(other.label)}</button>`;
    }).join("")
  }</div></div>`;
}

function bindInspectorButtons() {
  document.querySelectorAll("[data-node-id]").forEach(button => {
    button.addEventListener("click", () => {
      const node = nodeById.get(button.dataset.nodeId);
      if (node) dispatchGraphEvent("select-node", { node });
    });
  });
  document.querySelectorAll("[data-edge-id]").forEach(button => {
    button.addEventListener("click", () => {
      const edge = edgeById.get(button.dataset.edgeId);
      if (edge) dispatchGraphEvent("select-edge", { edge });
    });
  });
}

function expandNode(node) {
  expandingNodeId = node.id;
  expandPulseUntil = performance.now() + 950;
  selectNode(node);
  startSimulation({ alpha: 0.58 });
  window.setTimeout(() => {
    if (expandingNodeId === node.id) {
      expandingNodeId = "";
      render();
    }
  }, 980);
}

function selectNode(node) {
  active = { kind: "node", id: node.id };
  const details = cleanDetails(node.properties || node.details || {});
  document.getElementById("inspector-title").textContent = node.label || node.key;
  document.getElementById("inspector-subtitle").textContent = node.object_type || "unknown";
  document.getElementById("inspector-content").innerHTML = `
    ${node.object_type === "Missing Reference" ? `<div class="notice">This node is referenced by another layer but is missing from the expected ontology YAML.</div>` : ""}
    <div class="section">
      <h3>Identity</h3>
      <div class="kv"><div class="key">Id</div><div><code>${escapeHtml(node.key)}</code></div></div>
      <div class="kv"><div class="key">Node Type</div><div><code>${escapeHtml(node.object_type || "unknown")}</code></div></div>
    </div>
    ${relationButtons(node)}
    <div class="section"><h3>Details</h3>${renderValue(details) || "<p>No details.</p>"}</div>
  `;
  bindInspectorButtons();
  openInspector();
  render();
}

function selectEdge(edge) {
  active = { kind: "edge", id: edge.id };
  document.getElementById("inspector-title").textContent = edge.label || edge.type || "Relationship";
  document.getElementById("inspector-subtitle").textContent = `${edge.source.label} -> ${edge.target.label}`;
  document.getElementById("inspector-content").innerHTML = `
    ${edge.missing_endpoint ? `<div class="notice">This relationship points to at least one missing Object Instance.</div>` : ""}
    <div class="section">
      <h3>Relationship</h3>
      <div class="kv"><div class="key">Relation</div><div><code>${escapeHtml(edge.type || "")}</code></div></div>
      <div class="kv"><div class="key">Views</div><div>${(edge.views || []).map(item => `<code>${escapeHtml(item)}</code>`).join(" ")}</div></div>
      <div class="kv"><div class="key">Weight</div><div>${escapeHtml(edgeWeight(edge))}</div></div>
      <div class="kv"><div class="key">From</div><div><button type="button" data-node-id="${escapeHtml(edge.source.id)}">${escapeHtml(edge.source.label)}</button></div></div>
      <div class="kv"><div class="key">To</div><div><button type="button" data-node-id="${escapeHtml(edge.target.id)}">${escapeHtml(edge.target.label)}</button></div></div>
      <div class="kv"><div class="key">Source</div><div>${escapeHtml(edge.source_file || "")}</div></div>
    </div>
    <div class="section"><h3>Details</h3>${renderValue(cleanDetails(edge.details || {})) || "<p>No details.</p>"}</div>
  `;
  bindInspectorButtons();
  openInspector();
  render();
}

function clearSelection() {
  active = { kind: "", id: "" };
  closeInspector();
  render();
}

function renderOverview() {
  const typeRows = Object.entries(summary.object_types || {})
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<div class="summary-row"><div class="summary-name">${escapeHtml(type)}</div><div class="summary-count">${escapeHtml(count)}</div></div>`)
    .join("") || "<p>No node types.</p>";
  const relationRows = Object.entries(summary.relation_types || {})
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<div class="summary-row"><div class="summary-name">${escapeHtml(type)}</div><div class="summary-count">${escapeHtml(count)}</div></div>`)
    .join("") || "<p>No relationships.</p>";
  const layerRows = Object.entries(summary.layer_counts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([layer, count]) => `<div class="summary-row"><div class="summary-name">${escapeHtml(layer)}</div><div class="summary-count">${escapeHtml(count)}</div></div>`)
    .join("") || "<p>No layers.</p>";
  const viewRows = (summary.views || [])
    .map(viewInfo => `<div class="summary-row"><div class="summary-name">${escapeHtml(viewInfo.label)}</div><div class="summary-count">${escapeHtml(viewInfo.node_count)}</div></div>`)
    .join("") || "<p>No views.</p>";
  const missing = summary.missing_endpoints || [];
  const missingRefs = summary.missing_refs || [];
  document.getElementById("inspector-title").textContent = "Graph Overview";
  document.getElementById("inspector-subtitle").textContent = "Select a node or relationship to inspect its source details and YAML location.";
  document.getElementById("inspector-content").innerHTML = `
    ${summary.object_instances_loaded ? "" : `<div class="notice">Expected ontology/object-instances.yaml, but the file was not found.</div>`}
    ${missing.length ? `<div class="notice">Missing relationship endpoints: ${missing.map(item => `<code>${escapeHtml(item)}</code>`).join(" ")}</div>` : ""}
    ${missingRefs.length ? `<div class="notice">Missing cross-layer references: ${missingRefs.slice(0, 16).map(item => `<code>${escapeHtml(item)}</code>`).join(" ")}${missingRefs.length > 16 ? ` +${missingRefs.length - 16} more` : ""}</div>` : ""}
    <div class="section"><h3>Business Views</h3><div class="summary-list">${viewRows}</div></div>
    <div class="section"><h3>Layers</h3><div class="summary-list">${layerRows}</div></div>
    <div class="section"><h3>Node Types</h3><div class="summary-list">${typeRows}</div></div>
    <div class="section"><h3>Relation Types</h3><div class="summary-list">${relationRows}</div></div>
  `;
  openInspector();
}

function resetLayout() {
  stopSimulation();
  initialLayout();
  applyFilters({ resimulate: true, fit: true });
}

function initialize() {
  document.getElementById("total-nodes").textContent = summary.node_count ?? nodes.length;
  document.getElementById("total-edges").textContent = summary.edge_count ?? edges.length;
  const loadedFiles = summary.loaded_files || [];
  document.getElementById("source-file").textContent = loadedFiles.length
    ? `Sources: ${loadedFiles.map(shortPath).join(", ")}`
    : `Missing ontology YAML layers in ${shortPath(summary.ontology_dir || "ontology")}`;
  buildTypeFilter();
  initialLayout();
  renderOverview();
  applyFilters({ resimulate: true, fit: true });
}

searchInput.addEventListener("input", () => applyFilters());
typeFilter.addEventListener("change", () => applyFilters({ resimulate: true, fit: true }));
document.getElementById("fit-button").addEventListener("click", () => dispatchGraphEvent("fit-graph"));
document.getElementById("reset-button").addEventListener("click", () => dispatchGraphEvent("reset-layout"));
window.addEventListener("resize", fitGraph);
initialize();
</script>
</body>
</html>"""
    return template.replace("__GRAPH_DATA__", json_for_script(graph_data))


def main() -> int:
    parser = argparse.ArgumentParser(description="Build layered ontology review graph artifacts.")
    parser.add_argument("--ontology-dir", default=str(DEFAULT_ONTOLOGY_DIR), help="Directory containing ontology YAML files.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Directory for graph JSON and HTML.")
    parser.add_argument("--open", action="store_true", help="Open the generated HTML file.")
    args = parser.parse_args()

    ontology_dir = Path(args.ontology_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    graph_data = build_graph(ontology_dir)
    graph_path = output_dir / "ontology-graph.json"
    html_path = output_dir / "ontology-graph.html"
    graph_path.write_text(json.dumps(graph_data, ensure_ascii=False, indent=2, default=json_default), encoding="utf-8")
    html_path.write_text(render_html(graph_data), encoding="utf-8")

    summary = graph_data["summary"]
    print(f"Ontology graph: {summary['node_count']} nodes, {summary['edge_count']} relationships")
    if not summary["object_instances_loaded"]:
        print(f"Warning: expected canonical instance file: {summary['object_instances_file']}")
    if summary["missing_endpoint_count"]:
        print(f"Warning: {summary['missing_endpoint_count']} link endpoint(s) are missing from instances[]")
    if summary.get("missing_ref_count"):
        print(f"Warning: {summary['missing_ref_count']} cross-layer reference(s) are missing")
    print(f"Wrote {graph_path}")
    print(f"Wrote {html_path}")
    if args.open:
        webbrowser.open(html_path.resolve().as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
