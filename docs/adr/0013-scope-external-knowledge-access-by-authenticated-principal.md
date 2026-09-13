# Scope external knowledge access by authenticated principal

Status: superseded by ADR-0028

External API and MCP callers authenticate with an OAuth/Bearer identity that Knowledge Fabric maps to an existing tenant and user scope. The deployment gateway validates the JWT; only after that validation does Knowledge Fabric decode `data.tenant_id` and `data.user_id`, and the service must not be directly reachable around that gateway. A caller supplies a knowledge-base ID, but the server authorizes ownership in that mapped scope and never accepts tenant or user IDs as caller-controlled scope; this preserves the existing isolation model while offering the current dialogue capability externally. V1 adds no roles, sharing, or per-knowledge-base ACL: ownership is the sole authorization rule and JWT `role_ids` are not consulted. API-key issuance, rotation, and revocation are deferred because the service does not yet provide those capabilities.
