# Publish and test external contracts

Knowledge Fabric publishes its versioned REST contract as an in-repository OpenAPI 3.1 document covering authentication, catalog search, synchronous and SSE query responses, idempotency, recovery, and Problem Details errors. REST and MCP derive from shared query DTOs and are covered by contract tests so their externally visible semantics cannot drift.
