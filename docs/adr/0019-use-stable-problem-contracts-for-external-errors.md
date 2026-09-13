# Use stable problem contracts for external errors

The REST API returns machine-readable `application/problem+json` errors with a stable code, HTTP status, and request ID. The MCP tool returns a structured `isError` result with the corresponding code. Missing and unauthorized knowledge bases are both `404 knowledge_base_not_found`, preventing resource enumeration; `knowledge_base_not_query_ready` is the stable 409 code only when an owned knowledge base is not query-ready. Public errors do not disclose internal workspace or model-provider details.
