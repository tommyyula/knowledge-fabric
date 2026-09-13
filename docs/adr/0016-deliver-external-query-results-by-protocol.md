# Deliver external query results by protocol

The REST query API returns a final JSON result by default and offers an opt-in SSE response with the existing run and cursor reconnection model. The MCP query tool does not expose token streaming in v1. If a query is still running when the MCP client wait window ends, the tool returns structured `in_progress` data with the conversation, run, request, and retry information; repeating the identical query with the same request ID returns that run's final result rather than starting another run.
