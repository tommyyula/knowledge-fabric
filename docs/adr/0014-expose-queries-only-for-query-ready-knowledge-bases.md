# Expose queries only for query-ready knowledge bases

External API and MCP query operations are admitted only when the target knowledge base is query-ready: it is in the maintenance flow and ready phase. All other journey states, including a maintenance review, return the stable conflict `knowledge_base_not_query_ready`; callers neither wait for a transition nor receive answers from draft or in-progress knowledge.
