# Expose MCP through Streamable HTTP

Knowledge Fabric exposes its external MCP capability through a remote Streamable HTTP endpoint authenticated with the same OAuth/Bearer identity as the REST API. The existing in-process MCP servers remain private runner dependencies; v1 does not provide a local stdio distribution.
