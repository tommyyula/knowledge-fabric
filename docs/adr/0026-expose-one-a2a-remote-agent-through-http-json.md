# Expose one A2A Remote Agent through HTTP+JSON

Knowledge Fabric exposes one deployment-level, server-only A2A Remote Agent using the A2A 1.0 HTTP+JSON binding and the official JavaScript SDK; authenticated callers discover and explicitly select Query-ready Knowledge Bases through that agent rather than discovering one agent per knowledge base. The A2A adapter delegates execution to the existing external REST boundary so REST and MCP semantics remain authoritative, trading additional in-service protocol translation for a smaller regression surface and leaving other bindings, legacy compatibility, and outbound A2A calls for demonstrated future needs.

