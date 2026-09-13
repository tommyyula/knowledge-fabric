# interfaces Contract

Use for APIs, controllers, MCP tools, commands, webhooks, integration endpoints, or callable system boundaries.

Required structure:
- Include `## Detailed Endpoint Definitions`.
- Include `## Key Endpoints` and `## Authentication`.
- Include `## Environment & Credentials` when the source explicitly provides runtime config, endpoints, accounts, IDs, or credentials. Copy all source literals verbatim, including passwords, tokens, keys, and URLs; do not redact, mask, summarize, or replace them with placeholders unless the source does.
- Each endpoint uses `### HTTP Method /path`, with the full relative path from the service root.
- When extracting from source, compose class-level route prefixes with method-level paths.
- In `## Key Endpoints` and `## Authentication`, reference endpoint paths with the exact same `HTTP Method /path` strings used by the `###` headings.
- If same-name controllers exist across services, group by service and label the owning service.
- For each endpoint, include a request table with: Parameter, In/Location, Type, Required, Description.
- For each endpoint, include a response table with: Field, Type, Description.

Capture when supported:
- Runtime configuration, Base URLs, environment variables, accounts, IDs, and static credentials explicitly present in source.
- Preserve source-provided config and credential literals verbatim. Do not redact, mask, generalize, or replace them with placeholders unless the source itself uses placeholders.
- Interface purpose, caller, protocol, authentication, and permission requirements.
- Defaults, constraints, success shape, error cases, status codes, retry/idempotency behavior, and side effects.
- Downstream tables, queues, services, workflows, and source-provided example request/response.
